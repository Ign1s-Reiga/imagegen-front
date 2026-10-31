/**
 * A sprite: layers × frames of pixels. Documents are treated as immutable:
 * every edit makes a new document that shares the cels it did not touch, so
 * undo history is a list of documents and costs little memory.
 */
import { DEFAULT_PRESET, TRANSPARENT, alpha, blue, green, pack, red } from "./color.ts";

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
}

export interface Frame {
  id: string;
}

export interface PixelDoc {
  name: string;
  width: number;
  height: number;
  /** "#rrggbb" swatches. */
  palette: string[];
  /** Bottom to top. */
  layers: Layer[];
  frames: Frame[];
  /** Pixels per layer and frame, keyed by celKey. Missing means empty. */
  cels: Record<string, Uint32Array>;
  /** Playback speed for the whole animation. */
  fps: number;
}

export const MAX_SIDE = 256;
export const MAX_LAYERS = 32;
export const MAX_FRAMES = 128;

const newId = () => crypto.randomUUID();

export const celKey = (layerId: string, frameId: string) => `${layerId}/${frameId}`;

export function createDoc({
  width,
  height,
  palette = DEFAULT_PRESET.colors,
  name = "Untitled sprite",
}: {
  width: number;
  height: number;
  palette?: string[];
  name?: string;
}): PixelDoc {
  return {
    name,
    width: clampSide(width),
    height: clampSide(height),
    palette: [...palette],
    layers: [{ id: newId(), name: "Layer 1", visible: true, opacity: 1 }],
    frames: [{ id: newId() }],
    cels: {},
    fps: 8,
  };
}

export const clampSide = (n: number) => Math.max(1, Math.min(MAX_SIDE, Math.round(n) || 1));

export const blankPixels = (doc: Pick<PixelDoc, "width" | "height">) => new Uint32Array(doc.width * doc.height);

/** The cel's pixels, or a fresh blank array. Never mutate the result in place. */
export function celPixels(doc: PixelDoc, layerId: string, frameId: string): Uint32Array {
  return doc.cels[celKey(layerId, frameId)] ?? blankPixels(doc);
}

export function withCel(doc: PixelDoc, layerId: string, frameId: string, pixels: Uint32Array): PixelDoc {
  const cels = { ...doc.cels };
  const key = celKey(layerId, frameId);
  if (pixels.some((c) => c !== TRANSPARENT)) cels[key] = pixels;
  else delete cels[key];
  return { ...doc, cels };
}

/** Draws `src` over `dst` in place (straight alpha). */
export function blendOver(dst: Uint32Array, src: Uint32Array, opacity = 1) {
  for (let i = 0; i < dst.length; i++) {
    const s = src[i];
    const sa = (alpha(s) / 255) * opacity;
    if (sa <= 0) continue;
    const d = dst[i];
    if (sa >= 1 || alpha(d) === 0) {
      dst[i] = sa >= 1 ? s : pack(red(s), green(s), blue(s), Math.round(sa * 255));
      continue;
    }
    const da = alpha(d) / 255;
    const oa = sa + da * (1 - sa);
    const mix = (sc: number, dc: number) => Math.round((sc * sa + dc * da * (1 - sa)) / oa);
    dst[i] = pack(mix(red(s), red(d)), mix(green(s), green(d)), mix(blue(s), blue(d)), Math.round(oa * 255));
  }
}

/** All visible layers of a frame flattened into one image. */
export function composite(doc: PixelDoc, frameId: string, override?: { layerId: string; pixels: Uint32Array }): Uint32Array {
  const out = blankPixels(doc);
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    const pixels = override?.layerId === layer.id ? override.pixels : doc.cels[celKey(layer.id, frameId)];
    if (pixels) blendOver(out, pixels, layer.opacity);
  }
  return out;
}

// ---- Layers ----

export function addLayer(doc: PixelDoc, aboveIndex: number, name?: string): { doc: PixelDoc; id: string } {
  const id = newId();
  const layers = [...doc.layers];
  layers.splice(aboveIndex + 1, 0, { id, name: name ?? nextName(doc.layers.map((l) => l.name), "Layer"), visible: true, opacity: 1 });
  return { doc: { ...doc, layers }, id };
}

export function duplicateLayer(doc: PixelDoc, layerId: string): { doc: PixelDoc; id: string } {
  const index = doc.layers.findIndex((l) => l.id === layerId);
  const source = doc.layers[index];
  const { doc: next, id } = addLayer(doc, index, `${source.name} copy`);
  const cels = { ...next.cels };
  for (const frame of doc.frames) {
    const pixels = doc.cels[celKey(layerId, frame.id)];
    if (pixels) cels[celKey(id, frame.id)] = pixels;
  }
  const layers = next.layers.map((l) => (l.id === id ? { ...l, visible: source.visible, opacity: source.opacity } : l));
  return { doc: { ...next, layers, cels }, id };
}

export function removeLayer(doc: PixelDoc, layerId: string): PixelDoc {
  if (doc.layers.length <= 1) return doc;
  const cels = { ...doc.cels };
  for (const frame of doc.frames) delete cels[celKey(layerId, frame.id)];
  return { ...doc, layers: doc.layers.filter((l) => l.id !== layerId), cels };
}

export function moveLayer(doc: PixelDoc, layerId: string, delta: number): PixelDoc {
  const from = doc.layers.findIndex((l) => l.id === layerId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= doc.layers.length) return doc;
  const layers = [...doc.layers];
  const [layer] = layers.splice(from, 1);
  layers.splice(to, 0, layer);
  return { ...doc, layers };
}

export function updateLayer(doc: PixelDoc, layerId: string, patch: Partial<Omit<Layer, "id">>): PixelDoc {
  return { ...doc, layers: doc.layers.map((l) => (l.id === layerId ? { ...l, ...patch } : l)) };
}

/** Flattens a layer into the one below it, in every frame. */
export function mergeDown(doc: PixelDoc, layerId: string): PixelDoc {
  const index = doc.layers.findIndex((l) => l.id === layerId);
  if (index <= 0) return doc;
  const top = doc.layers[index];
  const below = doc.layers[index - 1];
  let next = doc;
  for (const frame of doc.frames) {
    const upper = doc.cels[celKey(top.id, frame.id)];
    if (!upper || !top.visible) continue;
    const merged = celPixels(doc, below.id, frame.id).slice();
    blendOver(merged, upper, top.opacity);
    next = withCel(next, below.id, frame.id, merged);
  }
  return removeLayer(next, top.id);
}

// ---- Frames ----

export function addFrame(doc: PixelDoc, afterIndex: number): { doc: PixelDoc; id: string } {
  const id = newId();
  const frames = [...doc.frames];
  frames.splice(afterIndex + 1, 0, { id });
  return { doc: { ...doc, frames }, id };
}

export function duplicateFrame(doc: PixelDoc, frameId: string): { doc: PixelDoc; id: string } {
  const index = doc.frames.findIndex((f) => f.id === frameId);
  const { doc: next, id } = addFrame(doc, index);
  const cels = { ...next.cels };
  for (const layer of doc.layers) {
    const pixels = doc.cels[celKey(layer.id, frameId)];
    if (pixels) cels[celKey(layer.id, id)] = pixels;
  }
  return { doc: { ...next, cels }, id };
}

export function removeFrame(doc: PixelDoc, frameId: string): PixelDoc {
  if (doc.frames.length <= 1) return doc;
  const cels = { ...doc.cels };
  for (const layer of doc.layers) delete cels[celKey(layer.id, frameId)];
  return { ...doc, frames: doc.frames.filter((f) => f.id !== frameId), cels };
}

export function moveFrame(doc: PixelDoc, frameId: string, delta: number): PixelDoc {
  const from = doc.frames.findIndex((f) => f.id === frameId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= doc.frames.length) return doc;
  const frames = [...doc.frames];
  const [frame] = frames.splice(from, 1);
  frames.splice(to, 0, frame);
  return { ...doc, frames };
}

function nextName(taken: string[], base: string) {
  for (let i = taken.length + 1; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

// ---- Files ----

/** On-disk form: JSON with each cel as base64 of its little-endian RGBA bytes. */
export interface PixelFile {
  format: "imagegen-pixel";
  version: 1;
  name: string;
  width: number;
  height: number;
  fps: number;
  palette: string[];
  layers: Layer[];
  frames: Frame[];
  cels: Record<string, string>;
}

function encodeCel(pixels: Uint32Array): string {
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeCel(base64: string, length: number): Uint32Array {
  const binary = atob(base64);
  if (binary.length !== length * 4) throw new Error("A cel has the wrong size.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Uint32Array(bytes.buffer);
}

export function toFile(doc: PixelDoc): PixelFile {
  return {
    format: "imagegen-pixel",
    version: 1,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    palette: doc.palette,
    layers: doc.layers,
    frames: doc.frames,
    cels: Object.fromEntries(Object.entries(doc.cels).map(([key, pixels]) => [key, encodeCel(pixels)])),
  };
}

export function fromFile(value: unknown): PixelDoc {
  const file = value as Partial<PixelFile> | null;
  if (!file || file.format !== "imagegen-pixel") throw new Error("This is not a pixel sprite file.");
  if (file.version !== 1) throw new Error(`Sprite file version ${String(file.version)} is not supported.`);
  const width = Number(file.width);
  const height = Number(file.height);
  if (!(width >= 1 && width <= MAX_SIDE && height >= 1 && height <= MAX_SIDE)) {
    throw new Error(`Sprites can be at most ${MAX_SIDE}×${MAX_SIDE}.`);
  }
  const layers = Array.isArray(file.layers) ? file.layers : [];
  const frames = Array.isArray(file.frames) ? file.frames : [];
  if (!layers.length || !frames.length) throw new Error("The sprite has no layers or frames.");
  const known = new Set(layers.flatMap((l) => frames.map((f) => celKey(l.id, f.id))));
  const cels: Record<string, Uint32Array> = {};
  for (const [key, data] of Object.entries(file.cels ?? {})) {
    if (known.has(key)) cels[key] = decodeCel(data, width * height);
  }
  return {
    name: String(file.name || "Untitled sprite"),
    width,
    height,
    fps: Math.max(1, Math.min(60, Number(file.fps) || 8)),
    palette: (file.palette ?? []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)),
    layers: layers.map((l) => ({
      id: String(l.id),
      name: String(l.name),
      visible: l.visible !== false,
      opacity: Math.max(0, Math.min(1, Number(l.opacity ?? 1))),
    })),
    frames: frames.map((f) => ({ id: String(f.id) })),
    cels,
  };
}
