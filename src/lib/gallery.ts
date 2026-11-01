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

/** One page of gallery_list, which may hold fewer rows than asked for (it caps the limit). */
export interface GenerationPage {
  generations: GenerationRecord[];
  /** Whether rows follow this page. */
  hasMore: boolean;
}

export const listGenerations = (query: ListQuery = {}) => invoke<GenerationPage>("gallery_list", { query });

/**
 * Lists `count` generations from `offset`, in as many calls as gallery_list's
 * cap needs. Each page says whether more follow, so the cap stays on the Rust
 * side.
 */
export async function listGenerationRange(
  query: Omit<ListQuery, "offset" | "limit">,
  offset: number,
  count: number,
): Promise<GenerationPage> {
  const generations: GenerationRecord[] = [];
  let hasMore = true;
  while (hasMore && generations.length < count) {
    const page = await listGenerations({ ...query, offset: offset + generations.length, limit: count - generations.length });
    generations.push(...page.generations);
    hasMore = page.hasMore;
  }
  return { generations, hasMore };
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
