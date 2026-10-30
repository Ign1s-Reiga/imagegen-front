import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { extForMime, imageDimensions, sniffImageMime, type Bytes } from "./bytes";
import type { GeneratedImage, Mode, ProviderKind } from "@/providers/types";

export interface ImageRecord {
  id: string;
  generationId: string;
  index: number;
  fileName: string;
  path: string;
  mime: string;
  width: number | null;
  height: number | null;
  seed: number | null;
  favorite: boolean;
}

/** Settings stored with each generation so it can be repeated. */
export interface StoredParams {
  width: number;
  height: number;
  count: number;
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  strength: number;
  options: Record<string, string>;
  connectionId: string;
  info?: Record<string, unknown>;
}

export interface GenerationRecord {
  id: string;
  createdAt: number;
  provider: ProviderKind;
  connectionName: string;
  model: string | null;
  mode: Mode;
  prompt: string;
  negativePrompt: string | null;
  params: StoredParams;
  durationMs: number | null;
  images: ImageRecord[];
}

export interface ListQuery {
  offset?: number;
  limit?: number;
  search?: string;
  favoritesOnly?: boolean;
}

export const imageSrc = (image: Pick<ImageRecord, "path">) => convertFileSrc(image.path);

const safeSeed = (seed: number | null | undefined) =>
  typeof seed === "number" && Number.isSafeInteger(seed) ? seed : null;

export async function saveGeneration(
  meta: Omit<GenerationRecord, "images">,
  images: GeneratedImage[],
): Promise<GenerationRecord> {
  const records: ImageRecord[] = [];
  for (const [index, image] of images.entries()) {
    const mime = sniffImageMime(image.bytes, image.mime);
    const written = await invoke<{ fileName: string; path: string }>("gallery_write_image", image.bytes, {
      headers: { "x-ext": extForMime(mime) },
    });
    const size = await imageDimensions(image.bytes, mime);
    records.push({
      id: crypto.randomUUID(),
      generationId: meta.id,
      index,
      fileName: written.fileName,
      path: written.path,
      mime,
      width: size?.width ?? null,
      height: size?.height ?? null,
      seed: safeSeed(image.seed),
      favorite: false,
    });
  }
  await invoke("gallery_commit", {
    generation: {
      ...meta,
      images: records.map(({ id, fileName, mime, width, height, seed }) => ({ id, fileName, mime, width, height, seed })),
    },
  });
  return { ...meta, images: records };
}

export const listGenerations = (query: ListQuery = {}) => invoke<GenerationRecord[]>("gallery_list", { query });

export const deleteGeneration = (id: string) => invoke<void>("gallery_delete_generation", { id });

export const deleteImage = (id: string) => invoke<void>("gallery_delete_image", { id });

export const setFavorite = (id: string, favorite: boolean) => invoke<void>("gallery_set_favorite", { id, favorite });

export async function readImageBytes(id: string): Promise<Bytes> {
  const buffer = await invoke<ArrayBuffer>("gallery_read_image", { id });
  return new Uint8Array(buffer);
}

export const exportImage = (id: string, destination: string) =>
  invoke<void>("gallery_export_image", { id, destination });

export const galleryDir = () => invoke<string>("gallery_dir");
