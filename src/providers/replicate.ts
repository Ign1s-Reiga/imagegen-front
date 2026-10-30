import { parseDataUri, sniffImageMime, toDataUri } from "@/lib/bytes";
import { HttpError, http, httpImage, httpJson, sleep, type HttpOptions } from "@/lib/http";

import { collectImageUrls, mapToSchema, mergeExtraJson, resolveProps, type SchemaProps } from "./schema-input";
import type { ConnectionConfig, GeneratedImage, InputImage, ProviderDefinition } from "./types";

const API = "https://api.replicate.com/v1";

function request(config: ConnectionConfig, init: HttpOptions = {}): HttpOptions {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiToken ?? ""}`);
  return { ...init, headers };
}

interface ModelInfo {
  latest_version?: { id: string; openapi_schema?: Record<string, unknown> };
}

interface Prediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
  logs?: string;
  urls: { get: string; cancel: string };
}

const FALLBACK_PROPS: SchemaProps = {
  prompt: {},
  negative_prompt: {},
  width: {},
  height: {},
  num_outputs: { maximum: 4 },
  seed: {},
  image: {},
  prompt_strength: {},
};

/** "owner/name" or "owner/name:version". */
function parseModel(model: string) {
  const [path, version] = model.trim().split(":");
  const [owner, name] = path.split("/");
  if (!owner || !name) throw new Error(`"${model}" is not a Replicate model. Use owner/name, e.g. black-forest-labs/flux-schnell.`);
  return { owner, name, version };
}

const schemaCache = new Map<string, { props: SchemaProps; versionId?: string }>();

async function modelSchema(config: ConnectionConfig, model: string, signal: AbortSignal) {
  const cached = schemaCache.get(model);
  if (cached) return cached;
  const { owner, name, version } = parseModel(model);
  const url = version ? `${API}/models/${owner}/${name}/versions/${version}` : `${API}/models/${owner}/${name}`;
  try {
    const info = await httpJson<ModelInfo & { id?: string; openapi_schema?: Record<string, unknown> }>(
      url,
      request(config, { signal }),
    );
    const doc = version ? info.openapi_schema : info.latest_version?.openapi_schema;
    const inputSchema = (doc?.components as { schemas?: Record<string, Record<string, unknown>> })?.schemas?.Input;
    const entry = { props: resolveProps(inputSchema, doc ?? {}), versionId: version ?? info.latest_version?.id };
    if (!Object.keys(entry.props).length) entry.props = FALLBACK_PROPS;
    schemaCache.set(model, entry);
    return entry;
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) throw err;
    console.warn(`Replicate schema for ${model} unavailable, using defaults`, err);
    return { props: FALLBACK_PROPS, versionId: version };
  }
}

/** Uploads through the Files API; falls back to a data URI. */
async function uploadInput(config: ConnectionConfig, image: InputImage, signal: AbortSignal): Promise<string> {
  try {
    const form = new FormData();
    form.append("content", new Blob([image.bytes], { type: image.mime }), image.name);
    const file = await httpJson<{ urls: { get: string } }>(
      `${API}/files`,
      request(config, { method: "POST", body: form, signal }),
    );
    return file.urls.get;
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn("Replicate file upload failed, sending a data URI", err);
    return toDataUri(image.bytes, image.mime);
  }
}

async function createPrediction(
  config: ConnectionConfig,
  model: string,
  versionId: string | undefined,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Prediction> {
  const post = (url: string, body: unknown) =>
    httpJson<Prediction>(
      url,
      request(config, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", Prefer: "wait=5" },
        signal,
      }),
    );
  const { owner, name, version } = parseModel(model);
  if (version) return post(`${API}/predictions`, { version, input });
  try {
    // Official models run without a version.
    return await post(`${API}/models/${owner}/${name}/predictions`, { input });
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404 || !versionId) throw err;
    return post(`${API}/predictions`, { version: versionId, input });
  }
}

export const replicate: ProviderDefinition = {
  kind: "replicate",
  label: "Replicate",
  summary: "Any image model on Replicate. Inputs are mapped from the model's schema.",
  fields: [
    { key: "apiToken", label: "API token", type: "secret", required: true, placeholder: "r8_..." },
    {
      key: "model",
      label: "Default model",
      type: "text",
      default: "black-forest-labs/flux-schnell",
      placeholder: "black-forest-labs/flux-schnell",
      help: "owner/name, or owner/name:version for community models.",
    },
  ],
  options: [
    {
      key: "extra",
      label: "Extra input",
      type: "json",
      default: "",
      help: 'JSON merged into the input, e.g. {"go_fast": true}',
    },
  ],
  capabilities: () => ({
    img2img: true,
    mask: true,
    negativePrompt: true,
    seed: true,
    steps: true,
    cfg: true,
    sampler: false,
    scheduler: false,
    strength: true,
    size: true,
    model: true,
    maxCount: 4,
    sizeStep: 8,
  }),
  defaultModel: (config) => config.model || "black-forest-labs/flux-schnell",
  suggestedModels: [
    "black-forest-labs/flux-schnell",
    "black-forest-labs/flux-dev",
    "black-forest-labs/flux-1.1-pro",
    "black-forest-labs/flux-kontext-pro",
    "stability-ai/stable-diffusion-3.5-large",
  ],
  defaults: { steps: 0, cfg: 0 },

  async testConnection(config, signal) {
    const account = await httpJson<{ username?: string }>(`${API}/account`, request(config, { signal }));
    return `Signed in to Replicate${account.username ? ` as ${account.username}` : ""}.`;
  },

  async generate(params, config, ctx) {
    const model = params.model || replicate.defaultModel(config);
    const { props, versionId } = await modelSchema(config, model, ctx.signal);

    const refs: { init?: string; mask?: string } = {};
    if (params.mode === "img2img") {
      if (!params.initImage) throw new Error("Add an input image for image to image.");
      ctx.onProgress({ stage: "uploading", message: "Uploading input image" });
      refs.init = await uploadInput(config, params.initImage, ctx.signal);
      if (params.mask) refs.mask = await uploadInput(config, params.mask, ctx.signal);
    }
    const input = mergeExtraJson(mapToSchema(props, params, refs), params.options.extra);

    let prediction = await createPrediction(config, model, versionId, input, ctx.signal);
    const cancel = () => void http(prediction.urls.cancel, request(config, { method: "POST" })).catch(() => {});
    ctx.signal.addEventListener("abort", cancel, { once: true });

    try {
      while (prediction.status === "starting" || prediction.status === "processing") {
        if (prediction.status === "starting") {
          ctx.onProgress({ stage: "queued", message: "Starting model" });
        } else {
          // Diffusers log tqdm bars; the last percentage is the best progress signal.
          const percents = [...(prediction.logs ?? "").matchAll(/(\d{1,3})%\|/g)];
          const last = percents.at(-1);
          ctx.onProgress({
            stage: "running",
            message: "Generating",
            fraction: last ? Number(last[1]) / 100 : undefined,
          });
        }
        await sleep(1000, ctx.signal);
        prediction = await httpJson<Prediction>(prediction.urls.get, request(config, { signal: ctx.signal }));
      }
      if (prediction.status === "failed") throw new Error(`Prediction failed: ${prediction.error ?? "unknown error"}`);
      if (prediction.status === "canceled") throw new Error("Prediction was canceled on Replicate.");

      const urls = collectImageUrls(prediction.output);
      if (!urls.length) throw new Error("The model finished but returned no images.");

      ctx.onProgress({ stage: "downloading", message: "Downloading" });
      const images: GeneratedImage[] = [];
      for (const url of urls) {
        const data = url.startsWith("data:") ? parseDataUri(url) : null;
        const image = data
          ? { bytes: data.bytes, mime: sniffImageMime(data.bytes, data.mime) }
          : await httpImage(url, request(config, { signal: ctx.signal }));
        images.push({ ...image, seed: "seed" in input ? params.seed : null });
      }
      return { images, model, info: { predictionId: prediction.id } };
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
    }
  },
};
