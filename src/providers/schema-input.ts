import type { GenerateParams } from "./types";

/** A JSON-schema property after $ref/allOf resolution. */
export interface SchemaProp {
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  format?: string;
  /** True when the property also accepts an object (fal's ImageSize). */
  acceptsObject?: boolean;
}

export type SchemaProps = Record<string, SchemaProp>;

type JsonSchema = Record<string, unknown>;

/** Flattens refs, allOf and anyOf/oneOf enough to read type, enum and bounds. */
export function resolveProps(schema: JsonSchema | undefined, root: JsonSchema): SchemaProps {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  const deref = (node: JsonSchema): JsonSchema => {
    const ref = node.$ref as string | undefined;
    if (!ref?.startsWith("#/")) return node;
    let target: unknown = root;
    for (const part of ref.slice(2).split("/")) target = (target as JsonSchema | undefined)?.[part];
    return (target as JsonSchema) ?? {};
  };
  const result: SchemaProps = {};
  for (const [name, raw] of Object.entries(props)) {
    const merged: SchemaProp = {};
    const visit = (node: JsonSchema, depth = 0) => {
      if (depth > 4) return;
      const resolved = deref(node);
      if (resolved.type) {
        if (resolved.type === "object") merged.acceptsObject = true;
        else merged.type ??= resolved.type as string;
      }
      if (resolved.properties && !resolved.type) merged.acceptsObject = true;
      if (Array.isArray(resolved.enum)) merged.enum = [...(merged.enum ?? []), ...resolved.enum];
      if (typeof resolved.minimum === "number") merged.minimum = resolved.minimum;
      if (typeof resolved.maximum === "number") merged.maximum = resolved.maximum;
      if (resolved.default !== undefined) merged.default ??= resolved.default;
      if (typeof resolved.format === "string") merged.format ??= resolved.format;
      for (const key of ["allOf", "anyOf", "oneOf"] as const) {
        const list = resolved[key];
        if (Array.isArray(list)) for (const item of list) visit(item as JsonSchema, depth + 1);
      }
    };
    visit(raw);
    result[name] = merged;
  }
  return result;
}

const clamp = (value: number, prop?: SchemaProp) => {
  let v = value;
  if (typeof prop?.minimum === "number") v = Math.max(v, prop.minimum);
  if (typeof prop?.maximum === "number") v = Math.min(v, prop.maximum);
  return v;
};

/** Picks the "W:H" enum entry closest to the requested aspect ratio. */
function nearestAspect(choices: unknown[], width: number, height: number): string | undefined {
  const target = Math.log(width / height);
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const choice of choices) {
    const match = typeof choice === "string" ? /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(choice) : null;
    if (!match) continue;
    const distance = Math.abs(Math.log(Number(match[1]) / Number(match[2])) - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = choice as string;
    }
  }
  return best;
}

const FAL_SIZE_PRESETS: Record<string, [number, number]> = {
  square_hd: [1024, 1024],
  square: [512, 512],
  portrait_4_3: [768, 1024],
  portrait_16_9: [576, 1024],
  landscape_4_3: [1024, 768],
  landscape_16_9: [1024, 576],
};

function nearestFalPreset(choices: unknown[], width: number, height: number): string | undefined {
  const target = Math.log(width / height);
  return choices
    .filter((c): c is string => typeof c === "string" && c in FAL_SIZE_PRESETS)
    .sort((a, b) => {
      const [aw, ah] = FAL_SIZE_PRESETS[a];
      const [bw, bh] = FAL_SIZE_PRESETS[b];
      const da = Math.abs(Math.log(aw / ah) - target) + Math.abs(aw * ah - width * height) / 1e7;
      const db = Math.abs(Math.log(bw / bh) - target) + Math.abs(bw * bh - width * height) / 1e7;
      return da - db;
    })[0];
}

export interface ImageRefs {
  /** URL or data URI of the init image. */
  init?: string;
  mask?: string;
  /** URLs or data URIs of reference images, in order. */
  references?: string[];
}

/** Image inputs that take a list, e.g. several references for an edit model. */
const LIST_IMAGE_KEYS = ["image_urls", "input_images", "images", "reference_images", "reference_image_urls", "image_input"];
const SINGLE_IMAGE_KEYS = ["image_url", "image", "input_image", "init_image"];

const first = (props: SchemaProps, names: string[]) => names.find((n) => n in props);

/**
 * Maps neutral params onto whatever names a model's input schema uses.
 * Only properties present in `props` are sent; `props` may be a fallback
 * guess when the schema could not be loaded.
 */
export function mapToSchema(props: SchemaProps, params: GenerateParams, refs: ImageRefs): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: params.prompt };

  if (params.negativePrompt.trim() && "negative_prompt" in props) input.negative_prompt = params.negativePrompt;

  const { width, height } = params;
  if ("width" in props && "height" in props) {
    input.width = clamp(width, props.width);
    input.height = clamp(height, props.height);
    if (props.aspect_ratio?.enum?.includes("custom")) input.aspect_ratio = "custom";
  } else if ("image_size" in props) {
    const prop = props.image_size;
    if (prop.acceptsObject || !prop.enum) input.image_size = { width, height };
    else input.image_size = nearestFalPreset(prop.enum, width, height) ?? prop.default;
  } else if ("aspect_ratio" in props) {
    const ratio = props.aspect_ratio.enum ? nearestAspect(props.aspect_ratio.enum, width, height) : undefined;
    input.aspect_ratio = ratio ?? `${width}:${height}`;
  }

  const countKey = first(props, ["num_outputs", "num_images", "batch_size", "number_of_images"]);
  if (countKey) input[countKey] = clamp(params.count, props[countKey]);

  if ("seed" in props) input.seed = params.seed;

  const stepsKey = first(props, ["num_inference_steps", "steps"]);
  if (stepsKey && params.steps > 0) input[stepsKey] = clamp(params.steps, props[stepsKey]);

  const cfgKey = first(props, ["guidance_scale", "guidance", "cfg_scale", "cfg"]);
  if (cfgKey && params.cfg > 0) input[cfgKey] = clamp(params.cfg, props[cfgKey]);

  const references = refs.references ?? [];
  if (references.length) {
    // The input image (when editing) goes first, then the references.
    const images = [...(params.mode === "img2img" && refs.init ? [refs.init] : []), ...references];
    const listKey = first(props, LIST_IMAGE_KEYS);
    const singleKey = first(props, SINGLE_IMAGE_KEYS);
    if (listKey) input[listKey] = images;
    else if (singleKey && images.length === 1) input[singleKey] = images[0];
    else if (singleKey) throw new Error("This model takes one image. Remove reference images, or pick a model that takes several.");
    else throw new Error("This model takes no images. Remove the reference images, or pick a model that takes them.");
  } else if (params.mode === "img2img" && refs.init) {
    const imageKey = first(props, [...SINGLE_IMAGE_KEYS, "image_urls", "input_images"]);
    if (!imageKey) throw new Error("This model has no image input. Pick an image-to-image model.");
    input[imageKey] = imageKey.endsWith("s") ? [refs.init] : refs.init;
  }

  if (params.mode === "img2img" && refs.init) {
    const strengthKey = first(props, ["strength", "prompt_strength", "denoising_strength", "image_strength"]);
    if (strengthKey) input[strengthKey] = params.strength;
    if (refs.mask) {
      const maskKey = first(props, ["mask_url", "mask", "mask_image"]);
      if (maskKey) input[maskKey] = refs.mask;
    }
  }

  if (props.output_format?.enum?.includes("png")) input.output_format = "png";

  return input;
}

/** Merges the user's "extra JSON" option over the mapped input. */
export function mergeExtraJson(input: Record<string, unknown>, extra: string | undefined) {
  if (!extra?.trim()) return input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extra);
  } catch {
    throw new Error("Extra input is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra input must be a JSON object.");
  }
  return { ...input, ...(parsed as Record<string, unknown>) };
}

/** Finds image URLs in an arbitrary model output. */
export function collectImageUrls(output: unknown): string[] {
  const urls: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value == null) return;
    if (typeof value === "string") {
      if (/^(https?:\/\/|data:image\/)/.test(value)) urls.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.url === "string") {
        const type = (obj.content_type ?? obj.contentType) as string | undefined;
        if (!type || type.startsWith("image/")) urls.push(obj.url);
        return;
      }
      for (const key of ["images", "image", "output", "outputs", "data"]) {
        if (key in obj) visit(obj[key], depth + 1);
      }
    }
  };
  visit(output, 0);
  return [...new Set(urls)];
}
