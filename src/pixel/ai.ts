/**
 * The AI operations of the pixel editor. Each one sends the sprite (or a
 * prompt) to the active backend through the app's generation runner, then
 * snaps every returned image back onto the sprite's grid and palette.
 */
import { provider } from "@/providers/registry";
import type { Capabilities, ProviderKind, RunContext } from "@/providers/types";
import { activeConnection, activeWorkflow, useApp, type GenerationRequest } from "@/store/app";

import { hexToPacked, keyColorFor, packedToHex, usedColors, type Packed } from "./color.ts";
import { composite, type PixelDoc } from "./doc.ts";
import { decodeImage, regionMask, spriteInput } from "./image-io.ts";
import type { Rect } from "./raster.ts";
import { edgesMostlyClear, snapToGrid } from "./snap.ts";

export type AiOp = "create" | "edit" | "vary";

export interface Candidate {
  id: string;
  op: AiOp;
  /** The sprite size the result was made for. */
  width: number;
  height: number;
  /** The whole sprite-sized result. For edits, only `region` is applied. */
  pixels: Uint32Array;
  region: Rect | null;
  /** Colours of a newly picked palette (create without the sprite's palette). */
  newPalette: string[] | null;
  generationId: string;
  prompt: string;
}

export interface CreateOptions {
  prompt: string;
  count: number;
  /** Use the sprite's palette, or pick `colors` new ones from the result. */
  keepPalette: boolean;
  colors: number;
  removeBackground: boolean;
}

export interface EditOptions {
  prompt: string;
  region: Rect;
  strength: number;
}

export interface VaryOptions {
  prompt: string;
  count: number;
  strength: number;
  keepPalette: boolean;
  colors: number;
}

const PIXEL_STYLE = "pixel art, crisp square pixels, limited palette, flat colours, no anti-aliasing";
const SPRITE_STYLE = "single centred sprite on a plain solid background";
const PIXEL_NEGATIVE = "blurry, smooth shading, gradients, anti-aliasing, photo, 3d render, text, watermark";

/** Which AI operations the active backend can run, with a reason when it cannot. */
export function aiSupport(caps: Capabilities | null): Record<AiOp, string | null> {
  if (!caps) {
    const reason = "Add a connection first.";
    return { create: reason, edit: reason, vary: reason };
  }
  const noImages = caps.img2img ? null : "This backend can only make images from text. Choose one that edits images.";
  return {
    create: caps.img2imgOnly ? "The selected workflow needs an input image. Use Variations, or pick another workflow." : null,
    edit: noImages,
    vary: noImages,
  };
}

/** A generation size near one megapixel with the sprite's shape, in sizes the backend takes. */
export function generationSize(width: number, height: number, caps: Capabilities, kind: ProviderKind) {
  const aspect = width / height;
  if (kind === "openai") {
    if (aspect > 1.2) return { width: 1536, height: 1024 };
    if (aspect < 1 / 1.2) return { width: 1024, height: 1536 };
    return { width: 1024, height: 1024 };
  }
  const step = Math.max(8, caps.sizeStep);
  const area = 1024 * 1024;
  const w = Math.max(step, Math.round(Math.sqrt(area * aspect) / step) * step);
  const h = Math.max(step, Math.round(w / aspect / step) * step);
  return { width: w, height: h };
}

function backend() {
  const state = useApp.getState();
  const connection = activeConnection(state);
  if (!connection) throw new Error("Add a connection first.");
  const caps = provider(connection.kind).capabilities(connection.config, activeWorkflow(state));
  return { connection, caps };
}

async function run(request: Omit<GenerationRequest, "negativePrompt" | "seed">, ctx: RunContext) {
  const { record, images } = await useApp
    .getState()
    .runGeneration({ ...request, negativePrompt: PIXEL_NEGATIVE, seed: null }, ctx);
  if (!images.length) throw new Error("The backend returned no images.");
  const decoded = await Promise.all(images.map((image) => decodeImage(image.bytes, image.mime)));
  return { generationId: record.id, decoded };
}

const sprite = (doc: PixelDoc) => ({ width: doc.width, height: doc.height });

/** The sprite's palette, or the colours it uses when the palette is empty. */
function workingPalette(doc: PixelDoc, pixels: Uint32Array): Packed[] {
  const palette = doc.palette.map(hexToPacked);
  return palette.length ? palette : usedColors([pixels], 64);
}

export async function createSprite(doc: PixelDoc, options: CreateOptions, ctx: RunContext): Promise<Candidate[]> {
  const { connection, caps } = backend();
  const reason = aiSupport(caps).create;
  if (reason) throw new Error(reason);
  if (!options.prompt.trim()) throw new Error("Describe the sprite first.");
  const palette = options.keepPalette ? doc.palette.map(hexToPacked) : null;
  if (options.keepPalette && !palette?.length) throw new Error("The palette is empty. Add colours, or let the AI pick them.");

  const size = generationSize(doc.width, doc.height, caps, connection.kind);
  const prompt = `${options.prompt.trim()}, ${PIXEL_STYLE}, ${SPRITE_STYLE}`;
  const { generationId, decoded } = await run(
    { mode: "txt2img", prompt, ...size, count: options.count, strength: 1, initImage: null, mask: null },
    ctx,
  );
  return decoded.map((image) => {
    const snapped = snapToGrid(image, {
      ...sprite(doc),
      palette,
      colors: options.colors,
      removeBackground: options.removeBackground,
    });
    return {
      id: crypto.randomUUID(),
      op: "create",
      ...sprite(doc),
      pixels: snapped.pixels,
      region: null,
      newPalette: palette ? null : snapped.palette.map(packedToHex),
      generationId,
      prompt: options.prompt.trim(),
    };
  });
}

export async function editRegion(doc: PixelDoc, frameId: string, options: EditOptions, ctx: RunContext): Promise<Candidate[]> {
  const { connection, caps } = backend();
  const reason = aiSupport(caps).edit;
  if (reason) throw new Error(reason);
  if (!options.prompt.trim()) throw new Error("Describe the change first.");

  const flat = composite(doc, frameId);
  const palette = workingPalette(doc, flat);
  if (!palette.length) throw new Error("The sprite is empty. Draw something or create a sprite first.");
  const key = keyColorFor(palette);
  const size = generationSize(doc.width, doc.height, caps, connection.kind);
  const initImage = await spriteInput(flat, doc.width, doc.height, size.width, size.height, key);
  const mask = caps.mask ? await regionMask(options.region, doc.width, doc.height, size.width, size.height) : null;
  const { generationId, decoded } = await run(
    {
      mode: "img2img",
      prompt: `${options.prompt.trim()}, ${PIXEL_STYLE}`,
      ...size,
      count: 1,
      // A mask keeps the rest intact, so the region can change a lot. Without one
      // the whole image is re-rendered (only the region is kept), at the chosen strength.
      strength: mask ? Math.max(options.strength, 0.75) : options.strength,
      initImage,
      mask,
    },
    ctx,
  );
  return decoded.map((image) => {
    const snapped = snapToGrid(image, { ...sprite(doc), palette, keyColor: key });
    return {
      id: crypto.randomUUID(),
      op: "edit",
      ...sprite(doc),
      pixels: snapped.pixels,
      region: options.region,
      newPalette: null,
      generationId,
      prompt: options.prompt.trim(),
    };
  });
}

export async function varySprite(doc: PixelDoc, frameId: string, options: VaryOptions, ctx: RunContext): Promise<Candidate[]> {
  const { connection, caps } = backend();
  const reason = aiSupport(caps).vary;
  if (reason) throw new Error(reason);
  if (!options.prompt.trim()) throw new Error("Describe the sprite and what to change.");

  const flat = composite(doc, frameId);
  if (!flat.some((c) => c !== 0)) throw new Error("This frame is empty. Draw something or create a sprite first.");
  const palette = options.keepPalette ? workingPalette(doc, flat) : null;
  const key = keyColorFor(palette ?? usedColors([flat], 64));
  const size = generationSize(doc.width, doc.height, caps, connection.kind);
  const initImage = await spriteInput(flat, doc.width, doc.height, size.width, size.height, key);
  const { generationId, decoded } = await run(
    {
      mode: "img2img",
      prompt: `${options.prompt.trim()}, ${PIXEL_STYLE}`,
      ...size,
      count: options.count,
      strength: options.strength,
      initImage,
      mask: null,
    },
    ctx,
  );
  // Models often paint their own background over the key colour; a sprite
  // that had clear edges should come back with clear edges.
  const removeBackground = !palette || edgesMostlyClear(flat, doc.width, doc.height);
  return decoded.map((image) => {
    const snapped = snapToGrid(image, {
      ...sprite(doc),
      palette,
      colors: options.colors,
      keyColor: palette ? key : null,
      removeBackground,
    });
    return {
      id: crypto.randomUUID(),
      op: "vary",
      ...sprite(doc),
      pixels: snapped.pixels,
      region: null,
      newPalette: palette ? null : snapped.palette.map(packedToHex),
      generationId,
      prompt: options.prompt.trim(),
    };
  });
}
