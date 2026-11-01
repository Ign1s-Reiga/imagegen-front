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
  try {
    for (const [index, image] of images.entries()) {
      const mime = sniffImageMime(image.bytes, image.mime);
      const written = await invoke<{ fileName: string; path: string }>("gallery_write_image", image.bytes, {
        headers: { "x-ext": extForMime(mime) },
      });
      const record: ImageRecord = {
        id: crypto.randomUUID(),
        generationId: meta.id,
        index,
        fileName: written.fileName,
        path: written.path,
        mime,
        width: null,
        height: null,
        seed: safeSeed(image.seed),
        favorite: false,
      };
      // Tracked before anything else can fail, so the catch below removes it.
      records.push(record);
      const size = await imageDimensions(image.bytes, mime);
      record.width = size?.width ?? null;
      record.height = size?.height ?? null;
    }
    await invoke("gallery_commit", {
      generation: {
        ...meta,
        images: records.map(({ id, fileName, mime, width, height, seed }) => ({ id, fileName, mime, width, height, seed })),
      },
    });
  } catch (err) {
    // Files written before the failure would otherwise sit on disk with no row.
    if (records.length) {
      await invoke("gallery_discard_images", { fileNames: records.map((r) => r.fileName) }).catch(() => {});
    }
    throw err;
  }
  return { ...meta, images: records };
}

export const listGenerations = (query: ListQuery = {}) => invoke<GenerationRecord[]>("gallery_list", { query });

/**
 * Rows asked for per call. gallery_list caps the limit on its side and may
 * return fewer, so a short reply is not taken as the end of the list.
 */
const MAX_LIST = 500;

/** Lists `count` generations from `offset`, in as many calls as gallery_list's cap needs. */
export async function listGenerationRange(
  query: Omit<ListQuery, "offset" | "limit">,
  offset: number,
  count: number,
): Promise<GenerationRecord[]> {
  const out: GenerationRecord[] = [];
  while (out.length < count) {
    const limit = Math.min(MAX_LIST, count - out.length);
    const batch = await listGenerations({ ...query, offset: offset + out.length, limit });
    // Only an empty reply ends the list: a short one may just be the backend's cap.
    if (!batch.length) break;
    out.push(...batch);
  }
  return out;
}

export const deleteGeneration = (id: string) => invoke<void>("gallery_delete_generation", { id });

export const deleteImage = (id: string) => invoke<void>("gallery_delete_image", { id });

export const setFavorite = (id: string, favorite: boolean) => invoke<void>("gallery_set_favorite", { id, favorite });

export async function readImageBytes(id: string): Promise<Bytes> {
  const buffer = await invoke<ArrayBuffer>("gallery_read_image", { id });
  return new Uint8Array(buffer);
}

/** Asks where to save the image (the dialog runs in Rust) and copies it there. Returns null when the dialog was closed. */
export const exportImage = (id: string, suggestedName: string) =>
  invoke<string | null>("gallery_export_image", { id, suggestedName });

export const galleryDir = () => invoke<string>("gallery_dir");
