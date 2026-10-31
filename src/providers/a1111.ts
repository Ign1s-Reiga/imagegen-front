import { base64ToBytes, bytesToObjectUrl, sniffImageMime, toDataUri } from "@/lib/bytes";
import { http, httpJson, sleep, trimSlash, type HttpOptions } from "@/lib/http";

import { mergeExtraJson } from "./schema-input";
import type { ConnectionConfig, GeneratedImage, ProviderDefinition, RunContext } from "./types";

const DEFAULT_URL = "http://127.0.0.1:7860";

const api = (config: ConnectionConfig) => `${trimSlash(config.baseUrl || DEFAULT_URL)}/sdapi/v1`;

function request(config: ConnectionConfig, init: HttpOptions = {}): HttpOptions {
  const headers = new Headers(init.headers);
  if (config.username) headers.set("Authorization", `Basic ${btoa(`${config.username}:${config.password ?? ""}`)}`);
  return { ...init, headers };
}

interface GenerateResponse {
  images: string[];
  info?: string;
}

/** Polls /progress while the main request runs, forwarding live previews. */
function watchProgress(config: ConnectionConfig, ctx: RunContext) {
  let stopped = false;
  let preview: string | null = null;
  void (async () => {
    while (!stopped) {
      try {
        await sleep(900, ctx.signal);
        const state = await httpJson<{
          progress?: number;
          current_image?: string | null;
          state?: { sampling_step?: number; sampling_steps?: number; job_count?: number; job_no?: number };
        }>(`${api(config)}/progress?skip_current_image=false`, request(config, { signal: ctx.signal }));
        if (stopped) break;
        if (state.current_image) {
          const bytes = base64ToBytes(state.current_image);
          if (preview) URL.revokeObjectURL(preview);
          preview = bytesToObjectUrl(bytes, sniffImageMime(bytes));
        }
        const s = state.state;
        ctx.onProgress({
          stage: "running",
          fraction: state.progress,
          message: s?.sampling_steps ? `Step ${s.sampling_step ?? 0} of ${s.sampling_steps}` : "Generating",
          preview: preview ?? undefined,
        });
      } catch {
        // Progress is best effort; the main request reports real failures.
        if (ctx.signal.aborted) break;
      }
    }
  })();
  return () => {
    stopped = true;
    if (preview) URL.revokeObjectURL(preview);
  };
}

function parseSeeds(info: string | undefined): number[] {
  if (!info) return [];
  try {
    const parsed = JSON.parse(info);
    return Array.isArray(parsed.all_seeds) ? parsed.all_seeds : [];
  } catch {
    return [];
  }
}

export const a1111: ProviderDefinition = {
  kind: "a1111",
  label: "A1111 / Forge / SD.Next",
  summary: "Stable Diffusion WebUI started with --api, or any server with the same sdapi.",
  fields: [
    { key: "baseUrl", label: "Server URL", type: "url", default: DEFAULT_URL, placeholder: DEFAULT_URL, required: true },
    { key: "username", label: "API username", type: "text", placeholder: "Only with --api-auth" },
    { key: "password", label: "API password", type: "secret" },
  ],
  options: [
    {
      key: "extra",
      label: "Extra payload",
      type: "json",
      default: "",
      help: 'JSON merged into the request, e.g. {"enable_hr": true, "hr_scale": 1.5}',
    },
  ],
  capabilities: () => ({
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
  }),
  defaultModel: () => "",
  suggestedModels: [],
  defaults: { steps: 25, cfg: 7, sampler: "DPM++ 2M", scheduler: "Automatic" },

  async listModels(config, signal) {
    const models = await httpJson<{ title: string; model_name: string }[]>(`${api(config)}/sd-models`, request(config, { signal }));
    return models.map((m) => ({ value: m.title, label: m.model_name }));
  },

  async listSamplers(config, signal) {
    const [samplers, schedulers] = await Promise.all([
      httpJson<{ name: string }[]>(`${api(config)}/samplers`, request(config, { signal })),
      httpJson<{ label?: string; name: string }[]>(`${api(config)}/schedulers`, request(config, { signal })).catch(() => []),
    ]);
    return { samplers: samplers.map((s) => s.name), schedulers: schedulers.map((s) => s.label ?? s.name) };
  },

  async testConnection(config, signal) {
    const models = await httpJson<unknown[]>(`${api(config)}/sd-models`, request(config, { signal }));
    return `Connected. ${models.length} checkpoint${models.length === 1 ? "" : "s"} available.`;
  },

  async generate(params, config, ctx) {
    const payload: Record<string, unknown> = {
      prompt: params.prompt,
      negative_prompt: params.negativePrompt,
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfg_scale: params.cfg,
      seed: params.seed,
      batch_size: params.count,
      n_iter: 1,
      send_images: true,
      save_images: false,
    };
    if (params.sampler) payload.sampler_name = params.sampler;
    if (params.scheduler) payload.scheduler = params.scheduler;
    if (params.model) {
      payload.override_settings = { sd_model_checkpoint: params.model };
      payload.override_settings_restore_afterwards = false;
    }

    let endpoint = "txt2img";
    if (params.mode === "img2img") {
      if (!params.initImage) throw new Error("Add an input image for image to image.");
      endpoint = "img2img";
      payload.init_images = [toDataUri(params.initImage.bytes, params.initImage.mime)];
      payload.denoising_strength = params.strength;
      payload.resize_mode = 0;
      if (params.mask) {
        payload.mask = toDataUri(params.mask.bytes, params.mask.mime);
        payload.inpainting_fill = 1;
        payload.inpaint_full_res = false;
        payload.mask_blur = 4;
      }
    }

    const body = mergeExtraJson(payload, params.options.extra);
    const onAbort = () => void http(`${api(config)}/interrupt`, request(config, { method: "POST" })).catch(() => {});
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    ctx.onProgress({ stage: "running", message: "Generating" });
    const stopProgress = watchProgress(config, ctx);

    let response: GenerateResponse;
    try {
      response = await httpJson<GenerateResponse>(
        `${api(config)}/${endpoint}`,
        request(config, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          signal: ctx.signal,
        }),
      );
    } finally {
      stopProgress();
      ctx.signal.removeEventListener("abort", onAbort);
    }

    let encoded = response.images ?? [];
    // With a batch, the WebUI may prepend a grid image.
    if (params.count > 1 && encoded.length === params.count + 1) encoded = encoded.slice(1);
    const seeds = parseSeeds(response.info);
    const images: GeneratedImage[] = encoded.slice(0, Math.max(params.count, 1) * 4).map((b64, i) => {
      const bytes = base64ToBytes(b64);
      return { bytes, mime: sniffImageMime(bytes), seed: seeds[i] ?? params.seed + i };
    });
    if (!images.length) throw new Error("The WebUI returned no images.");
    return { images, model: params.model || undefined };
  },
};
