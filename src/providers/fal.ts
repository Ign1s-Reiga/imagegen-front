import { parseDataUri, sniffImageMime, toDataUri } from "@/lib/bytes";
import { http, httpImage, httpJson, sleep, type HttpOptions } from "@/lib/http";

import { collectImageUrls, mapToSchema, mergeExtraJson, resolveProps, type SchemaProps } from "./schema-input";
import type { ConnectionConfig, GeneratedImage, ProviderDefinition } from "./types";

const QUEUE = "https://queue.fal.run";

function request(config: ConnectionConfig, init: HttpOptions = {}): HttpOptions {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Key ${config.apiKey ?? ""}`);
  return { ...init, headers };
}

/** Used when the model's schema cannot be fetched. */
const FALLBACK_PROPS: SchemaProps = {
  prompt: {},
  negative_prompt: {},
  image_size: { acceptsObject: true },
  num_images: { maximum: 4 },
  seed: {},
  num_inference_steps: {},
  guidance_scale: {},
  image_url: {},
  strength: {},
  mask_url: {},
};

const schemaCache = new Map<string, SchemaProps>();

async function inputSchema(model: string, signal: AbortSignal): Promise<SchemaProps> {
  const cached = schemaCache.get(model);
  if (cached) return cached;
  try {
    const doc = await httpJson<Record<string, unknown>>(
      `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(model)}`,
      { signal },
    );
    const paths = doc.paths as Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: Record<string, unknown> }> } } }>;
    const post = paths?.[`/${model}`]?.post ?? Object.values(paths ?? {}).find((p) => p.post)?.post;
    const schema = post?.requestBody?.content?.["application/json"]?.schema;
    const ref = schema?.$ref as string | undefined;
    const target = ref ? (doc.components as { schemas: Record<string, Record<string, unknown>> })?.schemas?.[ref.split("/").pop()!] : schema;
    const props = resolveProps(target, doc);
    if (!Object.keys(props).length) throw new Error("empty schema");
    schemaCache.set(model, props);
    return props;
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn(`fal schema for ${model} unavailable, using defaults`, err);
    return FALLBACK_PROPS;
  }
}

interface QueueSubmit {
  request_id: string;
  status_url: string;
  response_url: string;
  cancel_url: string;
}

interface QueueStatus {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
  queue_position?: number;
  logs?: { message: string }[] | null;
  error?: string | null;
}

export const fal: ProviderDefinition = {
  kind: "fal",
  label: "fal.ai",
  summary: "Hosted models on fal.ai, called through its queue API.",
  fields: [
    { key: "apiKey", label: "API key", type: "secret", required: true },
    {
      key: "model",
      label: "Text to image model",
      type: "text",
      default: "fal-ai/flux/dev",
      placeholder: "fal-ai/flux/dev",
    },
    {
      key: "img2imgModel",
      label: "Image to image model",
      type: "text",
      default: "fal-ai/flux/dev/image-to-image",
      placeholder: "fal-ai/flux/dev/image-to-image",
      help: "Used in image to image mode when the model field is empty.",
    },
  ],
  options: [
    {
      key: "extra",
      label: "Extra input",
      type: "json",
      default: "",
      help: 'JSON merged into the request, e.g. {"enable_safety_checker": false}',
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
  defaultModel: (config) => config.model || "fal-ai/flux/dev",
  suggestedModels: [
    "fal-ai/flux/dev",
    "fal-ai/flux/schnell",
    "fal-ai/flux/dev/image-to-image",
    "fal-ai/flux-pro/v1.1-ultra",
    "fal-ai/flux-pro/kontext",
    "fal-ai/fast-sdxl",
  ],
  defaults: { steps: 28, cfg: 3.5 },

  async testConnection(config, signal) {
    if (!config.apiKey) throw new Error("Add your fal.ai API key.");
    // A bogus request id: 404 means the key was accepted, 401/403 means it was not.
    try {
      await http(`${QUEUE}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`, request(config, { signal }));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) throw new Error("fal.ai rejected the API key.");
      if (status !== 404 && status !== 422 && status !== 400) throw err;
    }
    return "fal.ai accepted the API key.";
  },

  async generate(params, config, ctx) {
    const model =
      params.model ||
      (params.mode === "img2img" ? config.img2imgModel || "fal-ai/flux/dev/image-to-image" : fal.defaultModel(config));
    const props = await inputSchema(model, ctx.signal);

    const refs =
      params.mode === "img2img"
        ? {
            init: params.initImage ? toDataUri(params.initImage.bytes, params.initImage.mime) : undefined,
            mask: params.mask ? toDataUri(params.mask.bytes, params.mask.mime) : undefined,
          }
        : {};
    if (params.mode === "img2img" && !refs.init) throw new Error("Add an input image for image to image.");
    const input = mergeExtraJson(mapToSchema(props, params, refs), params.options.extra);

    ctx.onProgress({ stage: "uploading", message: "Submitting" });
    const submit = await httpJson<QueueSubmit>(
      `${QUEUE}/${model}`,
      request(config, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "Content-Type": "application/json" },
        signal: ctx.signal,
      }),
    );
    const cancel = () => void http(submit.cancel_url, request(config, { method: "PUT" })).catch(() => {});
    ctx.signal.addEventListener("abort", cancel, { once: true });

    try {
      for (;;) {
        const status = await httpJson<QueueStatus>(`${submit.status_url}?logs=1`, request(config, { signal: ctx.signal }));
        if (status.status === "COMPLETED") {
          if (status.error) throw new Error(status.error);
          break;
        }
        if (status.status === "IN_QUEUE") {
          ctx.onProgress({ stage: "queued", message: status.queue_position ? `Position ${status.queue_position + 1} in queue` : "Queued" });
        } else {
          const lastLog = status.logs?.at(-1)?.message;
          const percent = lastLog ? /(\d{1,3})%/.exec(lastLog) : null;
          ctx.onProgress({
            stage: "running",
            message: lastLog?.slice(0, 80) || "Generating",
            fraction: percent ? Number(percent[1]) / 100 : undefined,
          });
        }
        await sleep(800, ctx.signal);
      }

      const result = await httpJson<Record<string, unknown>>(submit.response_url, request(config, { signal: ctx.signal }));
      const urls = collectImageUrls(result);
      if (!urls.length) throw new Error("fal.ai returned no images.");

      ctx.onProgress({ stage: "downloading", message: "Downloading" });
      const resultSeed = typeof result.seed === "number" ? result.seed : params.seed;
      const images: GeneratedImage[] = [];
      for (const url of urls) {
        const data = url.startsWith("data:") ? parseDataUri(url) : null;
        const image = data
          ? { bytes: data.bytes, mime: sniffImageMime(data.bytes, data.mime) }
          : await httpImage(url, { signal: ctx.signal });
        images.push({ ...image, seed: resultSeed });
      }
      return { images, model, info: { requestId: submit.request_id, timings: result.timings } };
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
    }
  },
};
