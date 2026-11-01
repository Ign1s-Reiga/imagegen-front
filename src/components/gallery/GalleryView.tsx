"use client";

import { FolderOpen, Search, Star, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { imageSrc, listGenerationRange, type GenerationRecord, type ImageRecord } from "@/lib/gallery";
import { openGalleryFolder } from "@/lib/image-actions";
import { connectionLabel } from "@/providers/registry";
import { useApp } from "@/store/app";

import { ImageActionBar } from "../ImageActionBar";
import { Button, IconButton, Segmented, cx } from "../ui";

const PAGE = 60;

interface GalleryResult {
  key: string;
  listKey: string;
  generations: GenerationRecord[];
  hasMore: boolean;
  error: string | null;
}

const EMPTY_RESULT: GalleryResult = { key: "", listKey: "", generations: [], hasMore: false, error: null };

interface Tile {
  generation: GenerationRecord;
  image: ImageRecord;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function Details({ tile, onClose }: { tile: Tile; onClose: () => void }) {
  const select = useApp((s) => s.select);
  const router = useRouter();
  const { generation, image } = tile;
  const open = () => {
    select(generation, image.index);
    router.push("/");
  };
  const p = generation.params;
  const rows: [string, string | number | null | undefined][] = [
    ["Model", generation.model],
    ["Backend", connectionLabel(generation.connectionName, generation.provider)],
    ["Mode", generation.mode === "img2img" ? "Image to image" : "Text to image"],
    ["Size", image.width && image.height ? `${image.width} × ${image.height}` : null],
    ["Seed", image.seed],
    ["Steps", p.steps || null],
    ["Guidance", p.cfg || null],
    ["Sampler", [p.sampler, p.scheduler].filter(Boolean).join(", ") || null],
    ["Change amount", generation.mode === "img2img" ? `${Math.round(p.strength * 100)}%` : null],
    ["Created", dateFormat.format(generation.createdAt)],
    ["Took", generation.durationMs !== null ? `${(generation.durationMs / 1000).toFixed(1)}s` : null],
  ];

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-line bg-panel" aria-label="Image details">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <ImageActionBar key={image.id} generation={generation} image={image} onDeleted={onClose} />
        <IconButton label="Close details" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-6">
        <button
          type="button"
          onClick={open}
          className="block w-full bg-surround p-3"
          title="Open in Generate"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageSrc(image)} alt={generation.prompt} className="mx-auto max-h-[46vh] object-contain" />
        </button>
        <p className="mt-4 whitespace-pre-wrap font-serif text-[16px] leading-[1.5] text-fg">{generation.prompt}</p>
        {generation.negativePrompt && (
          <p className="mt-2 font-serif text-[14.5px] italic leading-snug text-fg-dim">
            Avoid: {generation.negativePrompt}
          </p>
        )}
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {rows
            .filter(([, value]) => value !== null && value !== undefined && value !== "")
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-fg-faint">{label}</dt>
                <dd className="break-words text-fg-dim">{value}</dd>
              </div>
            ))}
        </dl>
        <Button className="mt-5" onClick={open}>
          Open in Generate
        </Button>
      </div>
    </aside>
  );
}

export function GalleryView() {
  const galleryVersion = useApp((s) => s.galleryVersion);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "favorites">("all");
  const [pages, setPages] = useState(1);
  const [result, setResult] = useState<GalleryResult>(EMPTY_RESULT);
  // The latest result, for the effect to append to without depending on it.
  const latest = useRef<GalleryResult>(EMPTY_RESULT);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // What is listed; a change here starts over from the newest generation.
  const listKey = JSON.stringify([query, filter, galleryVersion]);
  const requestKey = JSON.stringify([listKey, pages]);
  useEffect(() => {
    let cancelled = false;
    const prev = latest.current;
    const wanted = PAGE * pages;
    // Show more only fetches the next page and appends it.
    const sameList = prev.listKey === listKey && !prev.error;
    const from = sameList ? Math.min(prev.generations.length, wanted) : 0;
    const kept = prev.generations.slice(0, from);
    const done = (next: GalleryResult) => {
      if (cancelled) return;
      latest.current = next;
      setResult(next);
    };
    // Nothing to fetch: fewer pages than are loaded (the search box resets pages
    // before its query settles), or the list is already known to end sooner.
    if (from === wanted || (sameList && !prev.hasMore)) {
      const hasMore = prev.generations.length > wanted || prev.hasMore;
      void Promise.resolve().then(() => done({ key: requestKey, listKey, generations: kept, hasMore, error: null }));
      return () => {
        cancelled = true;
      };
    }
    listGenerationRange({ search: query, favoritesOnly: filter === "favorites" }, from, wanted - from)
      .then((batch) =>
        done({
          key: requestKey,
          listKey,
          generations: [...kept, ...batch],
          hasMore: batch.length === wanted - from,
          error: null,
        }),
      )
      .catch((err) => done({ ...prev, key: requestKey, listKey, error: String(err) }));
    return () => {
      cancelled = true;
    };
  }, [query, filter, pages, listKey, requestKey]);

  const { generations, error, hasMore } = result;
  const loading = result.key !== requestKey;

  const tiles = useMemo<Tile[]>(
    () =>
      generations.flatMap((generation) =>
        generation.images
          .filter((image) => filter === "all" || image.favorite)
          .map((image) => ({ generation, image })),
      ),
    [generations, filter],
  );
  const selected = tiles.find((t) => t.image.id === selectedId) ?? null;

  return (
    <div className="flex h-full">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Gallery">
        <div className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-2">
          <div className="relative w-80">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPages(1);
              }}
              placeholder="Search prompts"
              aria-label="Search prompts"
              className="h-8 w-full rounded-[4px] border border-transparent bg-field pl-8 pr-2.5 text-fg placeholder:text-fg-faint hover:border-line focus:border-safelight/70 focus:outline-none"
            />
          </div>
          <div className="w-52">
            <Segmented
              label="Show"
              value={filter}
              onChange={(value) => {
                setFilter(value);
                setPages(1);
              }}
              options={[
                { value: "all", label: "All" },
                { value: "favorites", label: "Favorites" },
              ]}
            />
          </div>
          <span className="text-[13px] text-fg-faint">
            {loading ? "Loading" : `${tiles.length} image${tiles.length === 1 ? "" : "s"}`}
          </span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void openGalleryFolder()}>
            <FolderOpen size={14} />
            Open folder
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && <p className="text-danger">Could not read the gallery: {error}</p>}
          {!loading && !error && tiles.length === 0 && (
            <div className="mx-auto mt-24 max-w-sm text-center">
              {query || filter === "favorites" ? (
                <p className="text-fg-dim">
                  No images match{query ? ` “${query}”` : ""}
                  {filter === "favorites" ? " in your favorites" : ""}.
                </p>
              ) : (
                <>
                  <p className="font-serif text-[22px] italic text-fg-dim">The gallery is empty.</p>
                  <p className="mt-2 text-fg-faint">Every image you generate is saved here with its prompt and settings.</p>
                </>
              )}
            </div>
          )}

          <ul className="columns-[220px] gap-3">
            {tiles.map(({ generation, image }) => (
              <li key={image.id} className="mb-3 break-inside-avoid">
                <button
                  type="button"
                  onClick={() => setSelectedId(image.id)}
                  aria-pressed={selectedId === image.id}
                  className={cx(
                    "relative block w-full overflow-hidden rounded-[2px] bg-panel outline-offset-2",
                    selectedId === image.id && "outline-2 outline-safelight",
                  )}
                  style={image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageSrc(image)} alt={generation.prompt} loading="lazy" className="block size-full object-cover" />
                  {image.favorite && (
                    <Star
                      size={14}
                      fill="currentColor"
                      className="absolute right-2 top-2 text-safelight drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]"
                      aria-label="Favorite"
                    />
                  )}
                </button>
              </li>
            ))}
          </ul>

          {hasMore && (
            <div className="mt-2 flex justify-center">
              <Button onClick={() => setPages((p) => p + 1)} disabled={loading}>
                Show more
              </Button>
            </div>
          )}
        </div>
      </section>

      {selected && <Details tile={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
