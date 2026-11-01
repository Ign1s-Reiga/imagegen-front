import { base64ToBytes, sniffImageMime, toDataUri } from "@/lib/bytes";
import { httpJson, trimSlash, type HttpOptions } from "@/lib/http";

import type { ChatModel, ChatService } from "./chat";
import {
  fitImageBody,
  fromOpenRouterCompletion,
  nearestAspectRatio,
  parseOpenRouterCredit,
  resolutionTier,
  toOpenRouterMessages,
  type OpenRouterCompletion,
  type SupportedImageParams,
} from "./openrouter-format";
import type { ConnectionConfig, GeneratedImage, ProviderDefinition } from "./types";

const DEFAULT_BASE = "https://openrouter.ai/api/v1";

const base = (config: ConnectionConfig) => trimSlash(config.baseUrl || DEFAULT_BASE);

function request(config: ConnectionConfig, init: HttpOptions = {}, key = config.apiKey): HttpOptions {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key ?? ""}`);
  // Shown in the user's OpenRouter activity log.
  headers.set("X-Title", "ImageGen");
  if (init.body && typeof init.body === "string") headers.set("Content-Type", "application/json");
  return { ...init, headers };
}

interface ModelsResponse {
  data?: {
    id: string;
    name?: string;
    architecture?: { input_modalities?: string[] };
    supported_parameters?: SupportedImageParams;
  }[];
}

/** Each image model's supported parameters, per API base; read once a session. */
const imageParams = new Map<string, Promise<Map<string, SupportedImageParams>>>();

function imageParamsFor(config: ConnectionConfig, model: string, signal: AbortSignal) {
  const key = base(config);
  let models = imageParams.get(key);
  if (!models) {
    models = httpJson<ModelsResponse>(`${key}/images/models`, request(config, { signal })).then(
      (list) => new Map((list.data ?? []).flatMap((m) => (m.supported_parameters ? [[m.id, m.supported_parameters]] : []))),
    );
    imageParams.set(key, models);
    // A failed read is tried again next time rather than kept.
    models.catch(() => imageParams.delete(key));
  }
  // Without the list the request goes out unfitted, as before.
  return models.then((m) => m.get(model)).catch(() => undefined);
}

interface ImagesResponse {
  data?: { b64_json?: string; media_type?: string }[];
  usage?: Record<string, unknown>;
}

const chat: ChatService = {
  defaultModel: "anthropic/claude-opus-5.5",

  async listModels(config, signal) {
    const list = await httpJson<ModelsResponse>(`${base(config)}/models?supported_parameters=tools`, request(config, { signal }));
    return (list.data ?? [])
      .map((m): ChatModel => ({ id: m.id, label: m.name, vision: m.architecture?.input_modalities?.includes("image") ?? false }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  async send(req, config) {
    const body = {
      model: req.model,
      messages: toOpenRouterMessages(req.system, req.turns),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.schema },
            })),
          }
        : {}),
      max_completion_tokens: req.maxTokens ?? 32000,
      reasoning: { effort: req.effort ?? "medium" },
    };
    const json = await httpJson<OpenRouterCompletion>(
      `${base(config)}/chat/completions`,
      request(config, { method: "POST", body: JSON.stringify(body), signal: req.signal }),
    );
    const reply = fromOpenRouterCompletion(json, req.model);
    if (reply.turn.text) req.onText?.(reply.turn.text);
    return reply;
  },
};

export const openrouter: ProviderDefinition = {
  kind: "openrouter",
  label: "OpenRouter",
  summary: "Image models from many labs through one key, plus chat models for the prompt helper and the pixel assistant.",
  fields: [
    { key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "sk-or-..." },
    {
      key: "model",
      label: "Default image model",
      type: "text",
      placeholder: "Pick one in the Generate panel",
      help: "An OpenRouter image model ID. The Generate panel lists every image model your key can use.",
    },
    {
      key: "managementKey",
      label: "Management key",
      type: "secret",
      placeholder: "sk-or-...",
      help: "Only for showing the account balance, which regular keys cannot read. Without it the app shows this month's spending on the API key.",
    },
    {
      key: "baseUrl",
      label: "API base URL",
      type: "url",
      default: DEFAULT_BASE,
      placeholder: DEFAULT_BASE,
      help: "Change only for a proxy.",
    },
  ],
  options: [
    {
      key: "size",
      label: "Size",
      type: "select",
      default: "custom",
      options: [
        { value: "custom", label: "Match width and height" },
        { value: "auto", label: "Let the model choose" },
      ],
      help: "Sent as the nearest aspect ratio and a 1K, 2K or 4K tier; each model rounds to the sizes it makes.",
    },
    {
      key: "quality",
      label: "Quality",
      type: "select",
      default: "auto",
      options: ["auto", "low", "medium", "high"].map((v) => ({ value: v, label: v })),
      help: "Models without a quality setting ignore it.",
    },
    {
      key: "background",
      label: "Background",
      type: "select",
      default: "auto",
      options: ["auto", "opaque", "transparent"].map((v) => ({ value: v, label: v })),
      help: "Only some models can make transparent backgrounds.",
    },
  ],
  capabilities: () => ({
    img2img: true,
    mask: false,
    negativePrompt: false,
    seed: true,
    steps: false,
    cfg: false,
    sampler: false,
    scheduler: false,
    strength: false,
    size: true,
    model: true,
    maxCount: 4,
    references: 16,
    sizeStep: 8,
  }),
  defaultModel: (config) => config.model || "",
  suggestedModels: [],

  async listModels(config, signal) {
    const list = await httpJson<ModelsResponse>(`${base(config)}/images/models`, request(config, { signal }));
    return (list.data ?? []).map((m) => ({ value: m.id, label: m.name })).sort((a, b) => a.value.localeCompare(b.value));
  },

  async testConnection(config, signal) {
    const [images, chats] = await Promise.all([
      openrouter.listModels?.(config, signal) ?? Promise.resolve([]),
      chat.listModels(config, signal),
    ]);
    return `Key works. ${images.length} image model${images.length === 1 ? "" : "s"} and ${chats.length} chat models with tool use available.`;
  },

  async getCredit(config, signal) {
    const key = await httpJson<unknown>(`${base(config)}/key`, request(config, { signal }));
    const credits = config.managementKey
      ? await httpJson<unknown>(`${base(config)}/credits`, request(config, { signal }, config.managementKey))
      : undefined;
    return parseOpenRouterCredit(key, credits);
  },

  async generate(params, config, ctx) {
    const model = params.model || openrouter.defaultModel(config);
    if (!model) throw new Error("Choose an image model in the Model field. OpenRouter has no default.");
    const o = params.options;
    const body: Record<string, unknown> = { model, prompt: params.prompt, seed: params.seed };
    if (o.size !== "auto") {
      body.aspect_ratio = nearestAspectRatio(params.width, params.height);
      body.resolution = resolutionTier(params.width, params.height);
    }
    if (o.quality && o.quality !== "auto") body.quality = o.quality;
    if (o.background && o.background !== "auto") {
      body.background = o.background;
      if (o.background === "transparent") body.output_format = "png";
    }
    if (params.mode === "img2img" && !params.initImage) throw new Error("Add an input image to edit.");
    // The input image to edit comes first, then the reference images.
    const inputs = [...(params.mode === "img2img" && params.initImage ? [params.initImage] : []), ...params.references];
    if (inputs.length > 16) throw new Error("OpenRouter takes at most 16 images per request.");
    const supported = await imageParamsFor(config, model, ctx.signal);
    const refs = supported?.input_references;
    if (inputs.length && refs?.type === "range" && inputs.length > refs.max) {
      throw new Error(
        refs.max
          ? `${model} takes at most ${refs.max} input image${refs.max === 1 ? "" : "s"}, counting the image to edit.`
          : `${model} cannot take input images. Choose another model, or remove them.`,
      );
    }
    if (inputs.length) {
      body.input_references = inputs.map((image) => ({ type: "image_url", image_url: { url: toDataUri(image.bytes, image.mime) } }));
    }
    // Models reject parameters they do not take, such as a seed on FLUX 3 Image.
    const fitted = fitImageBody(body, supported);
    const seeded = "seed" in fitted.body;

    ctx.onProgress({ stage: "running", message: `Waiting for ${model}` });
    // Many image models make one image per request and reject n > 1, so each
    // image is its own request, with its own seed.
    const responses = await Promise.all(
      Array.from({ length: params.count }, (_, i) =>
        httpJson<ImagesResponse>(
          `${base(config)}/images`,
          request(config, {
            method: "POST",
            body: JSON.stringify(seeded ? { ...fitted.body, seed: (params.seed + i) % 2 ** 32 } : fitted.body),
            signal: ctx.signal,
          }),
        ),
      ),
    );
    ctx.onProgress({ stage: "downloading", message: "Decoding images" });
    const images: GeneratedImage[] = [];
    for (const [i, response] of responses.entries()) {
      for (const item of response.data ?? []) {
        if (!item.b64_json) continue;
        const bytes = base64ToBytes(item.b64_json);
        images.push({ bytes, mime: sniffImageMime(bytes, item.media_type), seed: seeded ? (params.seed + i) % 2 ** 32 : null });
      }
    }
    if (!images.length) throw new Error(`${model} returned no images.`);
    return {
      images,
      model,
      info: { usage: responses.map((r) => r.usage), ...(fitted.dropped.length ? { notSent: fitted.dropped } : {}) },
    };
  },

  chat,
};
