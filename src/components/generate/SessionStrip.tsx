"use client";

import { imageSrc } from "@/lib/gallery";
import { useApp } from "@/store/app";

import { cx } from "../ui";

export function SessionStrip() {
  const recent = useApp((s) => s.recent);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const job = useApp((s) => s.job);
  const running = job?.status === "running";

  return (
    <nav aria-label="Recent generations" className="flex w-[104px] shrink-0 flex-col border-l border-line bg-panel">
      <p className="px-3 pb-2 pt-3 text-[12.5px] text-fg-faint">Recent</p>
      <ol className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
        {running && (
          <li
            aria-label="Generating"
            className="grid aspect-square place-items-center rounded-[3px] border border-dashed border-safelight/60 text-[13px] text-safelight"
          >
            {job.progress?.fraction !== undefined ? `${Math.round(job.progress.fraction * 100)}%` : "…"}
          </li>
        )}
        {recent.map((generation) => {
          const cover = generation.images[0];
          if (!cover) return null;
          const selected = selection?.generationId === generation.id;
          return (
            <li key={generation.id}>
              <button
                type="button"
                onClick={() => select(generation)}
                aria-current={selected}
                title={generation.prompt}
                className={cx(
                  "relative block aspect-square w-full overflow-hidden rounded-[3px] bg-surround outline-offset-2",
                  selected ? "outline-2 outline-safelight" : "opacity-75 hover:opacity-100",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageSrc(cover)} alt={generation.prompt} className="size-full object-cover" loading="lazy" />
                {generation.images.length > 1 && (
                  <span className="absolute bottom-1 right-1 rounded-[3px] bg-surround/85 px-1 text-[11.5px] leading-4 text-fg">
                    {generation.images.length}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
