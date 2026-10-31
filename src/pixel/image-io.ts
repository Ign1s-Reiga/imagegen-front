/** Browser-side conversions between sprites, PNG bytes and model inputs. */
import type { Bytes } from "@/lib/bytes";
import type { InputImage } from "@/providers/types";

import { alpha, blue, green, red, type Packed } from "./color.ts";
import type { Rect } from "./raster.ts";
import type { RgbaImage } from "./snap.ts";

function context(canvas: OffscreenCanvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not available.");
  return ctx;
}

async function toPng(canvas: OffscreenCanvas): Promise<Bytes> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

export function pixelsToImageData(pixels: Uint32Array, width: number, height: number): ImageData {
  const data = new ImageData(width, height);
  new Uint32Array(data.data.buffer).set(pixels);
  return data;
}

export async function decodeImage(bytes: Bytes, mime: string): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = context(canvas);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Pixels as PNG, each sprite pixel drawn as a scale×scale square. */
export async function pixelsToPng(pixels: Uint32Array, width: number, height: number, scale = 1): Promise<Bytes> {
  return toPng(scaledCanvas([pixels], width, height, 1, scale));
}

/** Frames side by side, wrapping after `columns`. */
export async function spriteSheetPng(frames: Uint32Array[], width: number, height: number, columns: number, scale: number) {
  return toPng(scaledCanvas(frames, width, height, columns, scale));
}

function scaledCanvas(frames: Uint32Array[], width: number, height: number, columns: number, scale: number) {
  const cols = Math.max(1, Math.min(columns, frames.length));
  const rows = Math.ceil(frames.length / cols);
  const sheet = new OffscreenCanvas(width * cols, height * rows);
  const ctx = context(sheet);
  frames.forEach((pixels, i) => {
    ctx.putImageData(pixelsToImageData(pixels, width, height), (i % cols) * width, Math.floor(i / cols) * height);
  });
  if (scale === 1) return sheet;
  const out = new OffscreenCanvas(sheet.width * scale, sheet.height * scale);
  const outCtx = context(out);
  outCtx.imageSmoothingEnabled = false;
  outCtx.drawImage(sheet, 0, 0, out.width, out.height);
  return out;
}

/**
 * The sprite as a model input: flattened onto `background` (models only see
 * opaque images) and enlarged without smoothing to `outWidth`×`outHeight`.
 */
export async function spriteInput(
  pixels: Uint32Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
  background: Packed,
): Promise<InputImage> {
  const flat = new Uint32Array(pixels.length);
  const br = red(background);
  const bg = green(background);
  const bb = blue(background);
  for (let i = 0; i < pixels.length; i++) {
    const c = pixels[i];
    const a = alpha(c) / 255;
    if (a >= 1) flat[i] = c;
    else {
      const mix = (s: number, d: number) => Math.round(s * a + d * (1 - a));
      flat[i] = ((255 << 24) | (mix(blue(c), bb) << 16) | (mix(green(c), bg) << 8) | mix(red(c), br)) >>> 0;
    }
  }
  const small = new OffscreenCanvas(width, height);
  context(small).putImageData(pixelsToImageData(flat, width, height), 0, 0);
  const big = new OffscreenCanvas(outWidth, outHeight);
  const ctx = context(big);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, outWidth, outHeight);
  return { bytes: await toPng(big), mime: "image/png", name: "sprite.png", width: outWidth, height: outHeight };
}

/** The canonical mask (white = change) for a region of the sprite, at the model input's size. */
export async function regionMask(region: Rect, width: number, height: number, outWidth: number, outHeight: number): Promise<InputImage> {
  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = context(canvas);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, outWidth, outHeight);
  ctx.fillStyle = "#fff";
  const sx = outWidth / width;
  const sy = outHeight / height;
  const x0 = Math.floor(region.x * sx);
  const y0 = Math.floor(region.y * sy);
  ctx.fillRect(x0, y0, Math.ceil((region.x + region.w) * sx) - x0, Math.ceil((region.y + region.h) * sy) - y0);
  return { bytes: await toPng(canvas), mime: "image/png", name: "mask.png", width: outWidth, height: outHeight };
}
