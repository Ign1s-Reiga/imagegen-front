import { base64ToBytes, sniffImageMime, toDataUri } from "@/lib/bytes";
import { abortError, httpJson, trimSlash, type HttpOptions } from "@/lib/http";

import type { ChatModel, ChatService } from "./chat";
import {
  fitImageBody,
  fitSeed,
  isProviderSlug,
  modelPath,
  passthroughOptions,
  fromOpenRouterCompletion,
  nearestAspectRatio,
  parseOpenRouterCredit,
  resolutionTier,
  toOpenRouterMessages,
  type OpenRouterCompletion,
  type SupportedImageParams,
} from "./openrouter-format";
import type { ConnectionConfig, GeneratedImage, OptionField, ProviderDefinition } from "./types";

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

/** How long a generation waits for the model list or a model's endpoints before going on without them. */
const MODEL_LIST_TIMEOUT_MS = 15_000;

/** Options the user picks that a model may not take, with the names shown for them. */
const USER_SETTINGS = [
  ["quality", "Quality"],
  ["background", "Background"],
] as const;

/** The image model list, per URL; read once a session. */
const imageParams = new Map<string, Promise<ModelsResponse>>();

/**
 * Reads `url` once and shares the result through `cache` with every run that
 * asks for it. No run's abort signal goes on the request: one cancel would fail
 * it for all of them. A timeout instead, so a read that never answers cannot
 * hold up every generation for the rest of the session; a failed read is
 * dropped from the cache and tried again next time. Each run stops waiting on
 * its own cancel. Resolves to undefined when the read fails.
 */
async function sharedRead<T>(
  cache: Map<string, Promise<T>>,
  url: string,
  config: ConnectionConfig,
  signal: AbortSignal,
): Promise<T | undefined> {
  let pending = cache.get(url);
  if (!pending) {
    pending = httpJson<T>(url, request(config, { signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) }));
    cache.set(url, pending);
    pending.catch(() => cache.delete(url));
  }
  const found = pending.catch(() => undefined);
  let stop = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(abortError());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    stop = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([found, aborted]);
  } finally {
    stop();
  }
}

/** A model's supported parameters; undefined when the list cannot be read (the request then goes out unfitted). */
async function imageParamsFor(config: ConnectionConfig, model: string, signal: AbortSignal) {
  const list = await sharedRead(imageParams, `${base(config)}/images/models`, config, signal);
  return list?.data?.find((m) => m.id === model)?.supported_parameters;
}

interface EndpointsResponse {
  endpoints?: { provider_slug?: string; allowed_passthrough_parameters?: string[] }[];
}

/** Each model's provider endpoints, per URL; read once a session, and only when an option needs them. */
const imageEndpoints = new Map<string, Promise<EndpointsResponse>>();

/**
 * The keys each of the model's providers accepts passed through to it, by
 * provider slug; undefined when the endpoints could not be read, so callers
 * can tell "no provider takes it" from "unknown".
 */
async function passthroughKeys(config: ConnectionConfig, model: string, signal: AbortSignal) {
  const path = modelPath(model);
  // Not a model id, so no provider can take anything for it.
  if (!path) return {};
  const url = `${base(config)}/images/models/${path}/endpoints`;
  const found = await sharedRead(imageEndpoints, url, config, signal);
  if (!found) return undefined;
  // Slugs become object keys in provider.options, so only ones shaped like a
  // provider slug are kept; "__proto__" and the like never get that far.
  // A provider can serve a model from several endpoints; it takes a key if any
  // of them lists it.
  const accepted: Record<string, string[]> = Object.create(null);
  for (const e of found.endpoints ?? []) {
    if (!e.provider_slug || !isProviderSlug(e.provider_slug)) continue;
    const keys = (accepted[e.provider_slug] ??= []);
    for (const key of e.allowed_passthrough_parameters ?? []) if (!keys.includes(key)) keys.push(key);
  }
  return { ...accepted };
}

const OPTIONS: OptionField[] = [
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
  {
    key: "moderation",
    label: "Moderation",
    type: "select",
    default: "auto",
    options: ["auto", "low"].map((v) => ({ value: v, label: v })),
    help: "Low is less strict. This model's provider takes it as a provider-specific option.",
    // Shown only for models whose provider lists moderation (OpenAI's).
    perModel: true,
  },
];

/**
 * The options sent as provider-specific pass-throughs: every perModel option
 * is one, named by its key, and shown only for models whose providers list it.
 */
const PASSTHROUGH_FIELDS = OPTIONS.filter((f) => f.perModel);

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
  options: OPTIONS,
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

  async modelOptionKeys(config, model, signal) {
    const accepted = await passthroughKeys(config, model, signal ?? new AbortController().signal);
    // Thrown rather than read as "none", so the store does not keep a failed
    // lookup and asks again next time.
    if (!accepted) throw new Error(`Could not read the providers for ${model}.`);
    const listed = new Set(Object.values(accepted).flat());
    return PASSTHROUGH_FIELDS.flatMap((f) => (listed.has(f.key) ? [f.key] : []));
  },

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
    // Provider-specific options set to something other than their default.
    const passthrough = Object.fromEntries(
      PASSTHROUGH_FIELDS.flatMap((f) => (o[f.key] && o[f.key] !== f.default ? [[f.key, o[f.key]] as const] : [])),
    );
    // The two reads do not depend on each other, so a cold cache waits for one
    // timeout at most rather than one after the other.
    const [supported, accepted] = await Promise.all([
      imageParamsFor(config, model, ctx.signal),
      Object.keys(passthrough).length ? passthroughKeys(config, model, ctx.signal) : undefined,
    ]);
    // A model whose list leaves out input_references takes no images; without
    // this check fitImageBody would drop them and an edit would quietly become a
    // new picture. With no list at all, the images are sent and OpenRouter judges.
    const refs = supported?.input_references;
    const maxInputs = !supported ? Infinity : !refs ? 0 : refs.type === "range" ? refs.max : Infinity;
    if (inputs.length > maxInputs) {
      throw new Error(
        maxInputs
          ? `${model} takes at most ${maxInputs} input image${maxInputs === 1 ? "" : "s"}, counting the image to edit.`
          : `${model} cannot take input images. Choose another model, or remove them.`,
      );
    }
    // Edit-only models need at least one image, so say so here rather than as a 400.
    const minInputs = refs?.type === "range" ? refs.min : 0;
    if (inputs.length < minInputs) {
      throw new Error(
        `${model} needs at least ${minInputs} input image${minInputs === 1 ? "" : "s"}. Attach a reference image, or switch to image to image.`,
      );
    }
    if (inputs.length) {
      body.input_references = inputs.map((image) => ({ type: "image_url", image_url: { url: toDataUri(image.bytes, image.mime) } }));
    }
    // Models reject parameters they do not take, such as a seed on FLUX 3 Image.
    const fitted = fitImageBody(body, supported);
    // Provider-specific options are not image parameters but pass-throughs some
    // providers accept, so they go in provider.options for those only.
    const routed = passthroughOptions(passthrough, accepted);
    if (routed.options) fitted.body.provider = { options: routed.options };
    const seeded = "seed" in fitted.body;
    const seedOf = (i: number) => fitSeed(params.seed + i, supported?.seed);

    ctx.onProgress({ stage: "running", message: `Waiting for ${model}` });
    // Many image models make one image per request and reject n > 1, so each
    // image is its own request, with its own seed.
    const responses = await Promise.all(
      Array.from({ length: params.count }, (_, i) =>
        httpJson<ImagesResponse>(
          `${base(config)}/images`,
          request(config, {
            method: "POST",
            body: JSON.stringify(seeded ? { ...fitted.body, seed: seedOf(i) } : fitted.body),
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
        images.push({ bytes, mime: sniffImageMime(bytes, item.media_type), seed: seeded ? seedOf(i) : null });
      }
    }
    if (!images.length) throw new Error(`${model} returned no images.`);
    // Settings the user picked that the model does not take; the seed is not one
    // of them, as it is set on every run whether or not the user chose it.
    const ignored = USER_SETTINGS.filter(([key]) => fitted.dropped.includes(key)).map(([key, label]) => `${label} (${o[key]})`);
    // A provider-specific option set but not sent: left over from a model that
    // takes it, or the providers could not be read.
    for (const key of routed.unsent) {
      const field = PASSTHROUGH_FIELDS.find((f) => f.key === key);
      if (field) ignored.push(`${field.label} (${o[key]})`);
    }
    return {
      images,
      model,
      info: { usage: responses.map((r) => r.usage), ...(fitted.dropped.length ? { notSent: fitted.dropped } : {}) },
      notices: ignored.length
        ? [`${model} does not take ${ignored.join(" or ")}, so ${ignored.length === 1 ? "it was" : "they were"} not sent.`]
        : undefined,
    };
  },

  chat,
};
