/**
 * Masks are kept in one form everywhere: an opaque grayscale PNG at the input
 * image's size where white marks the area to change. Adapters convert from
 * there (OpenAI wants transparency instead).
 */
import type { InputImage } from "@/providers/types";

import type { Bytes } from "./bytes";

async function canvasToPng(canvas: OffscreenCanvas): Promise<Bytes> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

function context(canvas: OffscreenCanvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not available.");
  return ctx;
}

const luminance = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Converts any mask image to the canonical form at `width`×`height`.
 * Images with transparency use it (transparent = change, the OpenAI
 * convention); opaque images use brightness (white = change).
 */
export async function normalizeMask(bytes: Bytes, mime: string, width: number, height: number): Promise<InputImage> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = context(canvas);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  let transparent = false;
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] < 250) {
      transparent = true;
      break;
    }
  }
  for (let i = 0; i < px.length; i += 4) {
    const v = transparent ? 255 - px[i + 3] : luminance(px[i], px[i + 1], px[i + 2]);
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return { bytes: await canvasToPng(canvas), mime: "image/png", name: "mask.png", width, height };
}

/** Builds the canonical mask from painted alpha (any painted pixel = change). */
export async function maskFromAlpha(painted: ImageData): Promise<InputImage | null> {
  const { width, height } = painted;
  const out = new ImageData(width, height);
  let any = false;
  for (let i = 0; i < painted.data.length; i += 4) {
    const v = painted.data[i + 3];
    if (v) any = true;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  if (!any) return null;
  const canvas = new OffscreenCanvas(width, height);
  context(canvas).putImageData(out, 0, 0);
  return { bytes: await canvasToPng(canvas), mime: "image/png", name: "mask.png", width, height };
}

/** Reads a canonical mask back as alpha values, for further painting. */
export async function maskToAlpha(mask: InputImage, width: number, height: number): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(new Blob([mask.bytes], { type: mask.mime }));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = context(canvas);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const px = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) alpha[j] = px[i];
  return alpha;
}

/** OpenAI form: transparent where the image should change, opaque elsewhere. */
export async function maskForOpenAI(mask: InputImage): Promise<InputImage> {
  const bitmap = await createImageBitmap(new Blob([mask.bytes], { type: mask.mime }));
  const canvas = new OffscreenCanvas(mask.width, mask.height);
  const ctx = context(canvas);
  ctx.drawImage(bitmap, 0, 0, mask.width, mask.height);
  bitmap.close();
  const image = ctx.getImageData(0, 0, mask.width, mask.height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const change = px[i] > 127;
    px[i] = px[i + 1] = px[i + 2] = 0;
    px[i + 3] = change ? 0 : 255;
  }
  ctx.putImageData(image, 0, 0);
  return { ...mask, bytes: await canvasToPng(canvas), name: "mask.png" };
}
