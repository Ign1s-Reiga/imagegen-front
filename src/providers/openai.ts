import { base64ToBytes, sniffImageMime } from "@/lib/bytes";
import { httpImage, httpJson, trimSlash, type HttpOptions } from "@/lib/http";
import { maskForOpenAI } from "@/lib/mask";

import type { ConnectionConfig, GeneratedImage, GenerateParams, ProviderDefinition } from "./types";

const DEFAULT_BASE = "https://api.openai.com/v1";

const base = (config: ConnectionConfig) => trimSlash(config.baseUrl || DEFAULT_BASE);

function request(config: ConnectionConfig, init: HttpOptions = {}): HttpOptions {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.apiKey ?? ""}`);
  if (config.organization) headers.set("OpenAI-Organization", config.organization);
  if (config.project) headers.set("OpenAI-Project", config.project);
  return { ...init, headers };
}

interface ImagesResponse {
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  usage?: Record<string, unknown>;
}

const isDalle = (model: string) => model.startsWith("dall-e");

/** Request fields shared by generations and edits, as string pairs. */
function commonFields(params: GenerateParams, model: string): [string, string][] {
  const o = params.options;
  const fields: [string, string][] = [
    ["model", model],
    ["prompt", params.prompt],
    ["n", String(params.count)],
    ["size", o.size === "auto" ? "auto" : `${params.width}x${params.height}`],
  ];
  if (isDalle(model)) {
    fields.push(["response_format", "b64_json"]);
    return fields;
  }
  if (o.quality && o.quality !== "auto") fields.push(["quality", o.quality]);
  if (o.background && o.background !== "auto") fields.push(["background", o.background]);
  if (o.outputFormat) fields.push(["output_format", o.outputFormat]);
  if (o.outputFormat && o.outputFormat !== "png" && o.compression) {
    fields.push(["output_compression", o.compression]);
  }
  if (o.moderation && o.moderation !== "auto") fields.push(["moderation", o.moderation]);
  return fields;
}

export const openai: ProviderDefinition = {
  kind: "openai",
  label: "OpenAI",
  summary: "OpenAI image models through the Images API.",
  fields: [
    { key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "sk-..." },
    {
      key: "model",
      label: "Default model",
      type: "text",
      default: "gpt-image-2",
      placeholder: "gpt-image-2",
    },
    { key: "organization", label: "Organization ID", type: "text", placeholder: "Optional" },
    { key: "project", label: "Project ID", type: "text", placeholder: "Optional" },
    {
      key: "baseUrl",
      label: "API base URL",
      type: "url",
      default: DEFAULT_BASE,
      placeholder: DEFAULT_BASE,
      help: "Change only for an OpenAI-compatible proxy.",
    },
  ],
  options: [
    {
      key: "size",
      label: "Size",
      type: "select",
      default: "custom",
      options: [
        { value: "custom", label: "Use width and height" },
        { value: "auto", label: "Let the model choose" },
      ],
    },
    {
      key: "quality",
      label: "Quality",
      type: "select",
      default: "auto",
      options: ["auto", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, label: v })),
      help: "xhigh and max need gpt-image-2.5 models.",
    },
    {
      key: "background",
      label: "Background",
      type: "select",
      default: "auto",
      options: ["auto", "opaque", "transparent"].map((v) => ({ value: v, label: v })),
      help: "Transparent needs PNG or WebP output.",
    },
    {
      key: "outputFormat",
      label: "Format",
      type: "select",
      default: "png",
      options: ["png", "webp", "jpeg"].map((v) => ({ value: v, label: v })),
    },
    { key: "compression", label: "Compression", type: "number", default: "", help: "0 to 100, WebP and JPEG only." },
    {
      key: "moderation",
      label: "Moderation",
      type: "select",
      default: "auto",
      options: ["auto", "low"].map((v) => ({ value: v, label: v })),
    },
  ],
  capabilities: () => ({
    img2img: true,
    mask: true,
    negativePrompt: false,
    seed: false,
    steps: false,
    cfg: false,
    sampler: false,
    scheduler: false,
    strength: false,
    size: true,
    model: true,
    maxCount: 10,
    sizeStep: 16,
  }),
  defaultModel: (config) => config.model || "gpt-image-2",
  suggestedModels: [
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2",
    "gpt-image-1.5",
    "gpt-image-1",
    "gpt-image-1-mini",
  ],

  async listModels(config, signal) {
    const list = await httpJson<{ data: { id: string }[] }>(`${base(config)}/models`, request(config, { signal }));
    return list.data
      .map((m) => m.id)
      .filter((id) => /image|dall-e/i.test(id))
      .sort()
      .reverse()
      .map((value) => ({ value }));
  },

  async testConnection(config, signal) {
    const models = (await openai.listModels?.(config, signal)) ?? [];
    return models.length
      ? `Key works. ${models.length} image model${models.length === 1 ? "" : "s"} available.`
      : "Key works, but no image models are visible to this project.";
  },

  async generate(params, config, ctx) {
    const model = params.model || openai.defaultModel(config);
    const fields = commonFields(params, model);
    let response: ImagesResponse;

    ctx.onProgress({ stage: "running", message: `Waiting for ${model}` });
    if (params.mode === "img2img") {
      if (!params.initImage) throw new Error("Add an input image to edit.");
      const form = new FormData();
      for (const [key, value] of fields) form.append(key, value);
      const { initImage } = params;
      form.append("image", new Blob([initImage.bytes], { type: initImage.mime }), initImage.name);
      if (params.mask) {
        const mask = await maskForOpenAI(params.mask);
        form.append("mask", new Blob([mask.bytes], { type: mask.mime }), mask.name);
      }
      response = await httpJson<ImagesResponse>(
        `${base(config)}/images/edits`,
        request(config, { method: "POST", body: form, signal: ctx.signal }),
      );
    } else {
      const body: Record<string, unknown> = Object.fromEntries(fields);
      body.n = params.count;
      if (body.output_compression) body.output_compression = Number(body.output_compression);
      response = await httpJson<ImagesResponse>(
        `${base(config)}/images/generations`,
        request(config, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          signal: ctx.signal,
        }),
      );
    }

    ctx.onProgress({ stage: "downloading", message: "Decoding images" });
    const images: GeneratedImage[] = [];
    for (const item of response.data ?? []) {
      if (item.b64_json) {
        const bytes = base64ToBytes(item.b64_json);
        images.push({ bytes, mime: sniffImageMime(bytes) });
      } else if (item.url) {
        images.push(await httpImage(item.url, { signal: ctx.signal }));
      }
    }
    if (!images.length) throw new Error("OpenAI returned no images.");
    const revised = response.data?.find((d) => d.revised_prompt)?.revised_prompt;
    return { images, model, info: { usage: response.usage, revisedPrompt: revised } };
  },
};
