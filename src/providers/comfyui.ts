import WebSocket, { type Message } from "@tauri-apps/plugin-websocket";

import { bytesToObjectUrl, type Bytes } from "@/lib/bytes";
import { HttpError, abortError, cancelOnAbort, http, httpImage, httpJson, sleep, trimSlash, type HttpOptions } from "@/lib/http";

import {
  SAVE_NODE_ID,
  applyWorkflow,
  buildComfyWorkflow,
  comboChoices,
  uploadReferences,
  workflowCapabilities,
  type ComfyWorkflow,
  type UploadedRefs,
} from "./comfy-workflow";
import type {
  Capabilities,
  ConnectionConfig,
  GenerateParams,
  GeneratedImage,
  InputImage,
  ProviderDefinition,
  RunContext,
} from "./types";

const DEFAULT_URL = "http://127.0.0.1:8188";

const baseUrl = (config: ConnectionConfig) => trimSlash(config.baseUrl || DEFAULT_URL);

function request(config: ConnectionConfig, init: HttpOptions = {}): HttpOptions {
  const headers = new Headers(init.headers);
  if (config.token) headers.set("Authorization", `Bearer ${config.token}`);
  return { ...init, headers, stripOrigin: true };
}

async function nodeInputs(config: ConnectionConfig, node: string, signal?: AbortSignal) {
  const info = await httpJson<Record<string, { input?: { required?: Record<string, unknown> } }>>(
    `${baseUrl(config)}/object_info/${node}`,
    request(config, { signal }),
  );
  return info[node]?.input?.required ?? {};
}

interface ImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: ImageRef[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
}

/**
 * Uploads to Comfy's input folder and returns the name to load it by, as the
 * server reports it: with its subfolder, and renamed if a file of that name
 * was there and `overwrite` is off.
 */
async function uploadImage(
  config: ConnectionConfig,
  image: InputImage,
  signal: AbortSignal,
  { name = image.name, overwrite = true }: { name?: string; overwrite?: boolean } = {},
) {
  const form = new FormData();
  form.append("image", new Blob([image.bytes], { type: image.mime }), name);
  form.append("type", "input");
  form.append("overwrite", String(overwrite));
  const res = await httpJson<{ name: string; subfolder?: string }>(
    `${baseUrl(config)}/upload/image`,
    request(config, { method: "POST", body: form, signal }),
  );
  return res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
}

/** Turns a /prompt validation failure into one readable line. */
function describeQueueError(err: unknown): Error {
  if (!(err instanceof HttpError)) return err instanceof Error ? err : new Error(String(err));
  try {
    const body = JSON.parse(err.body);
    const nodeErrors = Object.values<{ class_type?: string; errors?: { message: string; details?: string }[] }>(
      body.node_errors ?? {},
    ).flatMap((node) =>
      (node.errors ?? []).map((e) => `${node.class_type ?? "node"}: ${e.message}${e.details ? ` (${e.details})` : ""}`),
    );
    const main = body.error?.message ?? "Workflow rejected";
    return new Error(nodeErrors.length ? `${main}. ${nodeErrors.join("; ")}` : main);
  } catch {
    return err;
  }
}

/** Collects websocket events for one client id. */
class ComfySocketState {
  done = new Set<string>();
  errors = new Map<string, string>();
  started = new Set<string>();
  promptId: string | null = null;
  private lastPreview: string | null = null;

  constructor(private readonly ctx: RunContext) {}

  handle(message: Message) {
    if (message.type === "Text") this.handleEvent(message.data);
    else if (message.type === "Binary") this.handlePreview(Uint8Array.from(message.data));
  }

  private handleEvent(raw: string) {
    let event: { type: string; data: Record<string, unknown> };
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const data = event.data ?? {};
    const id = data.prompt_id as string | undefined;
    switch (event.type) {
      case "status": {
        const remaining = (data.status as { exec_info?: { queue_remaining?: number } })?.exec_info
          ?.queue_remaining;
        if (this.promptId && !this.started.has(this.promptId) && remaining) {
          this.ctx.onProgress({ stage: "queued", message: `${remaining} in queue` });
        }
        break;
      }
      case "execution_start":
        if (id) this.started.add(id);
        if (id === this.promptId) this.ctx.onProgress({ stage: "running", message: "Loading" });
        break;
      case "progress":
        if (id && id === this.promptId) {
          const value = Number(data.value);
          const max = Number(data.max) || 1;
          this.ctx.onProgress({
            stage: "running",
            fraction: value / max,
            message: `Step ${value} of ${max}`,
            preview: this.lastPreview ?? undefined,
          });
        }
        break;
      case "executing":
        if (id && data.node === null) this.done.add(id);
        break;
      case "execution_success":
        if (id) this.done.add(id);
        break;
      case "execution_error":
        if (id) this.errors.set(id, `${data.node_type ?? "Node"} failed: ${data.exception_message ?? "unknown error"}`);
        break;
      case "execution_interrupted":
        if (id) this.errors.set(id, "Interrupted on the ComfyUI server");
        break;
    }
  }

  private handlePreview(buf: Bytes) {
    if (buf.length < 8) return;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const eventType = view.getUint32(0);
    let image: Bytes | null = null;
    let mime = "image/jpeg";
    if (eventType === 1) {
      mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
      image = buf.slice(8);
    } else if (eventType === 4) {
      // PREVIEW_IMAGE_WITH_METADATA: u32 metadata length, JSON, image bytes.
      const metaLength = view.getUint32(4);
      try {
        const meta = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + metaLength)));
        if (meta.prompt_id && meta.prompt_id !== this.promptId) return;
        mime = meta.image_type ?? mime;
      } catch {
        // Keep the default mime.
      }
      image = buf.slice(8 + metaLength);
    }
    if (!image) return;
    if (this.lastPreview) URL.revokeObjectURL(this.lastPreview);
    this.lastPreview = bytesToObjectUrl(image, mime);
  }

  dispose() {
    if (this.lastPreview) URL.revokeObjectURL(this.lastPreview);
  }
}

async function cancelPrompt(config: ConnectionConfig, promptId: string) {
  const json = (body: unknown) =>
    request(config, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  await Promise.allSettled([
    http(`${baseUrl(config)}/queue`, json({ delete: [promptId] })),
    http(`${baseUrl(config)}/interrupt`, json({ prompt_id: promptId })),
  ]);
}

async function readHistory(config: ConnectionConfig, promptId: string, signal: AbortSignal) {
  const history = await httpJson<Record<string, HistoryEntry>>(
    `${baseUrl(config)}/history/${promptId}`,
    request(config, { signal }),
  );
  return history[promptId] ?? null;
}

function historyError(entry: HistoryEntry): string | null {
  if (entry.status?.status_str !== "error") return null;
  const failure = entry.status.messages?.find(([name]) => name === "execution_error")?.[1];
  return failure
    ? `${failure.node_type ?? "Node"} failed: ${failure.exception_message ?? "unknown error"}`
    : "ComfyUI reported an error";
}

async function waitForOutputs(
  config: ConnectionConfig,
  promptId: string,
  socket: ComfySocketState | null,
  signal: AbortSignal,
): Promise<HistoryEntry> {
  // The websocket gives timely completion; history polling covers a missing
  // or dropped socket.
  for (let tick = 0; ; tick++) {
    if (signal.aborted) throw abortError();
    const socketError = socket?.errors.get(promptId);
    if (socketError) throw new Error(socketError);
    if (!socket || socket.done.has(promptId) || tick % 4 === 3) {
      const entry = await readHistory(config, promptId, signal);
      if (entry) {
        const error = historyError(entry);
        if (error) throw new Error(error);
        if (entry.status?.completed || (entry.outputs && Object.keys(entry.outputs).length)) return entry;
      }
    }
    await sleep(socket?.done.has(promptId) ? 300 : 700, signal);
  }
}

const BUILT_IN_CAPABILITIES: Capabilities = {
  img2img: true,
  mask: true,
  negativePrompt: true,
  seed: true,
  steps: true,
  cfg: true,
  sampler: true,
  scheduler: true,
  strength: true,
  size: true,
  model: true,
  maxCount: 16,
  references: 0,
  sizeStep: 8,
};

/** Uploads input images and returns the graph to queue. */
async function prepareWorkflow(
  params: GenerateParams,
  config: ConnectionConfig,
  ctx: RunContext,
): Promise<{ workflow: ComfyWorkflow; model?: string }> {
  const checkpoint = params.model || config.checkpoint;
  if (!params.workflow && !checkpoint) {
    throw new Error("Choose a checkpoint in the model field or in the connection settings.");
  }
  const refs: UploadedRefs = {};
  if (params.mode === "img2img") {
    if (!params.initImage) throw new Error("Add an input image for image to image.");
    ctx.onProgress({ stage: "uploading", message: "Uploading input image" });
    refs.initImage = await uploadImage(config, params.initImage, ctx.signal);
    if (params.mask) {
      refs.mask = await uploadImage(config, { ...params.mask, name: `mask-${params.initImage.name}` }, ctx.signal);
    }
  }
  if (params.workflow && params.references.length) {
    const count = params.references.length;
    ctx.onProgress({ stage: "uploading", message: `Uploading ${count} reference image${count === 1 ? "" : "s"}` });
    // Named by content and never overwriting: a file already there under that
    // name is this same image (ComfyUI keeps it rather than adding a copy),
    // and a different one is renamed rather than replaced.
    // A failed upload stops the others, rather than leaving them to finish
    // writing to the server after the error is shown.
    const uploads = new AbortController();
    const signal = AbortSignal.any([ctx.signal, uploads.signal]);
    try {
      refs.references = await uploadReferences(params.references, (image, name) =>
        uploadImage(config, image, signal, { name, overwrite: false }),
      );
    } catch (err) {
      uploads.abort();
      throw err;
    }
  }
  if (params.workflow) {
    return { workflow: applyWorkflow(params.workflow, params, refs), model: params.model || undefined };
  }
  return { workflow: buildComfyWorkflow(params, checkpoint, refs), model: checkpoint };
}

/** Saved outputs; previews only when an imported graph saves nothing. */
function collectOutputs(entry: HistoryEntry, imported: boolean): ImageRef[] {
  const all = imported
    ? Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? [])
    : (entry.outputs?.[SAVE_NODE_ID]?.images ?? []);
  const saved = all.filter((ref) => ref.type === "output");
  return saved.length || !imported ? saved : all;
}

export const comfyui: ProviderDefinition = {
  kind: "comfyui",
  label: "ComfyUI",
  summary: "A ComfyUI server on this machine, your network, or a cloud pod.",
  fields: [
    { key: "baseUrl", label: "Server URL", type: "url", default: DEFAULT_URL, placeholder: DEFAULT_URL, required: true },
    {
      key: "checkpoint",
      label: "Default checkpoint",
      type: "text",
      placeholder: "sd_xl_base_1.0.safetensors",
      help: "Used when the model field is empty. Pick one from the model list after connecting.",
    },
    {
      key: "token",
      label: "Access token",
      type: "secret",
      help: "Only for servers behind an auth proxy. Sent as a Bearer token.",
    },
  ],
  options: [],
  capabilities: (_config, workflow) =>
    workflow ? workflowCapabilities(workflow, BUILT_IN_CAPABILITIES) : BUILT_IN_CAPABILITIES,
  supportsWorkflows: true,
  defaultModel: (config) => config.checkpoint ?? "",
  suggestedModels: [],
  defaults: { steps: 25, cfg: 7, sampler: "euler", scheduler: "normal" },

  async listModels(config, signal) {
    const inputs = await nodeInputs(config, "CheckpointLoaderSimple", signal);
    return comboChoices(inputs.ckpt_name).map((value) => ({ value }));
  },

  async listSamplers(config, signal) {
    const inputs = await nodeInputs(config, "KSampler", signal);
    return { samplers: comboChoices(inputs.sampler_name), schedulers: comboChoices(inputs.scheduler) };
  },

  async listInputChoices(config, inputs, signal) {
    const result: Record<string, string[]> = {};
    const classes = [...new Set(inputs.map((i) => i.classType))];
    const infos = await Promise.all(
      classes.map(async (classType) => [classType, await nodeInputs(config, classType, signal).catch(() => ({}))] as const),
    );
    const byClass = Object.fromEntries(infos) as Record<string, Record<string, unknown>>;
    for (const { classType, input } of inputs) {
      const choices = comboChoices(byClass[classType]?.[input]);
      if (choices.length) result[`${classType}.${input}`] = choices;
    }
    return result;
  },

  async testConnection(config, signal) {
    const stats = await httpJson<{
      system?: { comfyui_version?: string };
      devices?: { name?: string }[];
    }>(`${baseUrl(config)}/system_stats`, request(config, { signal }));
    const version = stats.system?.comfyui_version ? ` ${stats.system.comfyui_version}` : "";
    const device = stats.devices?.[0]?.name?.replace(/^cuda:\d+\s*/, "");
    return `Connected to ComfyUI${version}${device ? ` on ${device}` : ""}`;
  },

  async generate(params, config, ctx) {
    const { workflow, model } = await prepareWorkflow(params, config, ctx);

    const clientId = crypto.randomUUID();
    const socketState = new ComfySocketState(ctx);
    let socket: WebSocket | null = null;
    try {
      const wsUrl = `${baseUrl(config).replace(/^http/, "ws")}/ws?clientId=${clientId}`;
      socket = await WebSocket.connect(wsUrl, {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
      });
      socket.addListener((message) => socketState.handle(message));
    } catch (err) {
      console.warn("ComfyUI websocket unavailable, falling back to polling", err);
    }

    let stopCancel = () => {};

    try {
      ctx.onProgress({ stage: "queued", message: "Queuing" });
      const queued = await httpJson<{ prompt_id: string }>(
        `${baseUrl(config)}/prompt`,
        request(config, {
          method: "POST",
          body: JSON.stringify({ prompt: workflow, client_id: clientId }),
          headers: { "Content-Type": "application/json" },
          // No abort signal; a cancel is handled once this returns (see cancelOnAbort).
        }),
      ).catch((err) => {
        throw describeQueueError(err);
      });
      const promptId = queued.prompt_id;
      socketState.promptId = promptId;
      stopCancel = cancelOnAbort(ctx.signal, () => void cancelPrompt(config, promptId));

      const entry = await waitForOutputs(config, promptId, socket ? socketState : null, ctx.signal);
      const outputs = collectOutputs(entry, Boolean(params.workflow));
      if (!outputs.length) throw new Error("ComfyUI finished without producing any images.");

      ctx.onProgress({ stage: "downloading", message: "Downloading" });
      const images: GeneratedImage[] = [];
      for (const ref of outputs) {
        const query = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
        const image = await httpImage(`${baseUrl(config)}/view?${query}`, request(config, { signal: ctx.signal }));
        images.push({ ...image, seed: params.seed });
      }
      return { images, model };
    } finally {
      stopCancel();
      socketState.dispose();
      void socket?.disconnect().catch(() => {});
    }
  },
};
