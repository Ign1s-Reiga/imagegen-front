import { base64ToBytes, bytesToBase64, extForMime, sniffImageMime } from "@/lib/bytes";
import { HttpError, cancelOnAbort, http, httpImage, httpJson, sleep, trimSlash, type HttpOptions } from "@/lib/http";

import { applyWorkflow, buildComfyWorkflow, workflowCapabilities, type UploadedRefs } from "./comfy-workflow";
import { parseRunpodMyself } from "./credit";
import type { Capabilities, ConnectionConfig, GeneratedImage, ProviderDefinition } from "./types";

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
  maxCount: 8,
  references: 0,
  sizeStep: 8,
};

const DEFAULT_API = "https://api.runpod.ai/v2";
/** Account data (balance, spend) is only on RunPod's GraphQL API. */
const GRAPHQL_API = "https://api.runpod.io/graphql";
const CREDIT_QUERY = "query ImageGenCredit { myself { clientBalance currentSpendPerHr spendLimit minBalance underBalance } }";

const endpointUrl = (config: ConnectionConfig) => {
  if (!config.endpointId) throw new Error("Set the endpoint ID in the connection settings.");
  return `${trimSlash(config.apiBase || DEFAULT_API)}/${config.endpointId.trim()}`;
};

function request(config: ConnectionConfig, init: HttpOptions = {}): HttpOptions {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiKey ?? ""}`);
  return { ...init, headers };
}

type JobStatus = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT";

interface WorkerImage {
  filename?: string;
  type: "base64" | "s3_url";
  data: string;
}

interface JobResponse {
  id: string;
  status: JobStatus;
  error?: string;
  output?: {
    images?: WorkerImage[];
    errors?: string[];
    error?: string;
    /** Pre-5.0 worker-comfyui put a single image here. */
    message?: string;
  };
}

async function decodeWorkerImage(image: WorkerImage, signal: AbortSignal): Promise<GeneratedImage> {
  if (image.type === "s3_url" || /^https?:\/\//.test(image.data)) return httpImage(image.data, { signal });
  const bytes = base64ToBytes(image.data);
  return { bytes, mime: sniffImageMime(bytes) };
}

export const runpod: ProviderDefinition = {
  kind: "runpod",
  label: "RunPod Serverless",
  summary: "A RunPod serverless endpoint running worker-comfyui.",
  fields: [
    { key: "endpointId", label: "Endpoint ID", type: "text", placeholder: "abc123xyz", required: true },
    { key: "apiKey", label: "API key", type: "secret", required: true },
    {
      key: "checkpoint",
      label: "Default checkpoint",
      type: "text",
      placeholder: "flux1-dev-fp8.safetensors",
      help: "File name of a checkpoint baked into the worker image or on its network volume. Not needed for imported workflows.",
    },
    { key: "apiBase", label: "API base URL", type: "url", default: DEFAULT_API, placeholder: DEFAULT_API },
  ],
  options: [],
  capabilities: (_config, workflow) =>
    workflow ? workflowCapabilities(workflow, BUILT_IN_CAPABILITIES) : BUILT_IN_CAPABILITIES,
  supportsWorkflows: true,
  defaultModel: (config) => config.checkpoint ?? "",
  suggestedModels: ["flux1-dev-fp8.safetensors", "flux1-schnell-fp8.safetensors", "sd_xl_base_1.0.safetensors"],
  defaults: { steps: 20, cfg: 1, sampler: "euler", scheduler: "simple" },

  async testConnection(config, signal) {
    const health = await httpJson<{
      workers?: { idle?: number; running?: number; ready?: number };
      jobs?: { inQueue?: number; inProgress?: number };
    }>(`${endpointUrl(config)}/health`, request(config, { signal }));
    const workers = health.workers ?? {};
    const ready = (workers.idle ?? 0) + (workers.running ?? 0);
    return `Endpoint reachable. ${ready} worker${ready === 1 ? "" : "s"} warm, ${health.jobs?.inQueue ?? 0} job${health.jobs?.inQueue === 1 ? "" : "s"} queued.`;
  },

  async getCredit(config, signal) {
    if (!config.apiKey) return null;
    try {
      const json = await httpJson<unknown>(
        GRAPHQL_API,
        request(config, {
          method: "POST",
          body: JSON.stringify({ query: CREDIT_QUERY }),
          headers: { "Content-Type": "application/json" },
          signal,
        }),
      );
      return parseRunpodMyself(json);
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw new Error(
          "RunPod refused this key for account data. If the key is limited to specific endpoints, create one with read access to the account.",
        );
      }
      throw err;
    }
  },

  async generate(params, config, ctx) {
    const checkpoint = params.model || config.checkpoint;
    if (!params.workflow && !checkpoint) throw new Error("Set a checkpoint file name for this endpoint.");

    // worker-comfyui writes these into ComfyUI's input folder before running.
    const images: { name: string; image: string }[] = [];
    const refs: UploadedRefs = {};
    if (params.mode === "img2img") {
      if (!params.initImage) throw new Error("Add an input image for image to image.");
      refs.initImage = `imagegen-input.${extForMime(params.initImage.mime)}`;
      images.push({ name: refs.initImage, image: bytesToBase64(params.initImage.bytes) });
      if (params.mask) {
        refs.mask = "imagegen-mask.png";
        images.push({ name: refs.mask, image: bytesToBase64(params.mask.bytes) });
      }
    }
    const workflow = params.workflow
      ? applyWorkflow(params.workflow, params, refs)
      : buildComfyWorkflow(params, checkpoint, refs);
    const model = params.workflow ? params.model || undefined : checkpoint;

    ctx.onProgress({ stage: "uploading", message: "Submitting job" });
    const job = await httpJson<JobResponse>(
      `${endpointUrl(config)}/run`,
      request(config, {
        method: "POST",
        body: JSON.stringify({ input: { workflow, ...(images.length ? { images } : {}) } }),
        headers: { "Content-Type": "application/json" },
        // No abort signal; a cancel is handled once this returns (see cancelOnAbort).
      }),
    );

    const stopCancel = cancelOnAbort(
      ctx.signal,
      () => void http(`${endpointUrl(config)}/cancel/${job.id}`, request(config, { method: "POST" })).catch(() => {}),
    );

    try {
      let status = job;
      const startedAt = Date.now();
      for (let delay = 1000; ; delay = Math.min(delay * 1.25, 3000)) {
        if (status.status === "COMPLETED") break;
        if (status.status === "FAILED") {
          throw new Error(`Job failed: ${status.error ?? status.output?.error ?? "no error message from worker"}`);
        }
        if (status.status === "CANCELLED") throw new Error("Job was canceled on RunPod.");
        if (status.status === "TIMED_OUT") throw new Error("Job timed out on RunPod.");

        const seconds = Math.round((Date.now() - startedAt) / 1000);
        ctx.onProgress(
          status.status === "IN_QUEUE"
            ? { stage: "queued", message: `Waiting for a worker (${seconds}s)` }
            : { stage: "running", message: `Generating (${seconds}s)` },
        );
        await sleep(delay, ctx.signal);
        status = await httpJson<JobResponse>(
          `${endpointUrl(config)}/status/${job.id}`,
          request(config, { signal: ctx.signal }),
        );
      }

      ctx.onProgress({ stage: "downloading", message: "Decoding images" });
      const output = status.output ?? {};
      let workerImages = output.images ?? [];
      if (!workerImages.length && output.message) workerImages = [{ type: "base64", data: output.message }];
      if (!workerImages.length) {
        throw new Error(`Worker returned no images${output.errors?.length ? `: ${output.errors.join("; ")}` : "."}`);
      }
      const results: GeneratedImage[] = [];
      for (const image of workerImages) {
        results.push({ ...(await decodeWorkerImage(image, ctx.signal)), seed: params.seed });
      }
      return { images: results, model, info: { jobId: job.id } };
    } finally {
      stopCancel();
    }
  },
};
