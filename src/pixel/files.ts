import { invoke } from "@tauri-apps/api/core";

import { sniffImageMime, type Bytes } from "@/lib/bytes";

import { MAX_SIDE, composite, fromFile, toFile, type PixelDoc } from "./doc.ts";
import { decodeImage, pixelsToPng, spriteSheetPng } from "./image-io.ts";
import { spriteFromPixels } from "./store.ts";

export const PROJECT_EXT = "pixel";

/** Header values must be plain ASCII; keep names readable but safe. */
export const safeFileName = (name: string) => name.replace(/[^A-Za-z0-9 ._@-]+/g, "-").replace(/^[-. ]+|[-. ]+$/g, "") || "sprite";

/** Shows a save dialog and writes the bytes. Returns the path, or null when the dialog was closed. */
export function saveBytes(bytes: Bytes, fileName: string, filter: { name: string; ext: string }) {
  return invoke<string | null>("save_file", bytes, {
    headers: { "x-file-name": safeFileName(fileName), "x-filter-name": filter.name, "x-filter-ext": filter.ext },
  });
}

export function saveProject(doc: PixelDoc) {
  const bytes = new TextEncoder().encode(JSON.stringify(toFile(doc)));
  return saveBytes(bytes, `${doc.name}.${PROJECT_EXT}`, { name: "Pixel sprite", ext: PROJECT_EXT });
}

export interface ExportOptions {
  what: "frame" | "sheet";
  scale: number;
  /** Sprite sheet only: frames per row. */
  columns: number;
}

export async function exportPng(doc: PixelDoc, frameId: string, options: ExportOptions) {
  const suffix = options.scale > 1 ? `@${options.scale}x` : "";
  if (options.what === "frame") {
    const index = doc.frames.findIndex((f) => f.id === frameId);
    const bytes = await pixelsToPng(composite(doc, frameId), doc.width, doc.height, options.scale);
    const name = doc.frames.length > 1 ? `${doc.name}-${index + 1}${suffix}.png` : `${doc.name}${suffix}.png`;
    return saveBytes(bytes, name, { name: "PNG image", ext: "png" });
  }
  const frames = doc.frames.map((f) => composite(doc, f.id));
  const bytes = await spriteSheetPng(frames, doc.width, doc.height, options.columns, options.scale);
  return saveBytes(bytes, `${doc.name}-sheet${suffix}.png`, { name: "PNG image", ext: "png" });
}

/** Reads a sprite project, or a PNG/GIF/WebP that is already pixel art. */
export async function openSpriteFile(file: File): Promise<PixelDoc> {
  const base = file.name.replace(/\.[^.]+$/, "") || "Untitled sprite";
  if (file.name.toLowerCase().endsWith(`.${PROJECT_EXT}`) || file.type === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name} is not a sprite file.`);
    }
    return fromFile(parsed);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let image;
  try {
    image = await decodeImage(bytes, sniffImageMime(bytes, file.type));
  } catch {
    throw new Error(`${file.name} is not an image this app can read.`);
  }
  if (image.width > MAX_SIDE || image.height > MAX_SIDE) {
    throw new Error(
      `${file.name} is ${image.width}×${image.height}. Images up to ${MAX_SIDE}×${MAX_SIDE} open as sprites; use Create to make pixel art from larger pictures.`,
    );
  }
  const pixels = new Uint32Array(image.data.buffer.slice(0));
  return spriteFromPixels(pixels, image.width, image.height, base);
}
