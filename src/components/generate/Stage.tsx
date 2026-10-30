"use client";

import { imageSrc } from "@/lib/gallery";
import { connectionLabel } from "@/providers/registry";
import { activeConnection, useApp } from "@/store/app";

import { ImageActionBar } from "../ImageActionBar";
import { CropMarks, cx } from "../ui";

function ProgressLine({ fraction }: { fraction?: number }) {
  return (
    <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fraction !== undefined ? Math.round(fraction * 100) : undefined}>
      {fraction !== undefined ? (
        <div className="h-full bg-safelight transition-[width] duration-300" style={{ width: `${Math.max(2, fraction * 100)}%` }} />
      ) : (
        <div className="h-full w-2/5 bg-safelight" style={{ animation: "indeterminate 1.4s ease-in-out infinite" }} />
      )}
    </div>
  );
}

const STAGE_LABEL = { uploading: "Uploading", queued: "Queued", running: "Generating", downloading: "Downloading" } as const;

export function Stage() {
  const recent = useApp((s) => s.recent);
  const selection = useApp((s) => s.selection);
  const select = useApp((s) => s.select);
  const job = useApp((s) => s.job);
  const connection = useApp(activeConnection);

  const generation = recent.find((g) => g.id === selection?.generationId) ?? null;
  const image = generation?.images[selection?.imageIndex ?? 0] ?? generation?.images[0] ?? null;
  const running = job?.status === "running";
  const preview = running ? job.progress?.preview : undefined;

  const shown = preview ?? (image ? imageSrc(image) : null);

  return (
    <section className="relative flex min-w-0 flex-1 flex-col bg-surround" aria-label="Result">
      {running && <ProgressLine fraction={job.progress?.fraction} />}

      <div className="relative grid min-h-0 flex-1 place-items-center overflow-hidden px-10 pb-4 pt-10">
        {shown ? (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={shown}
              src={shown}
              alt={generation?.prompt ?? "Generated image"}
              className={cx(
                "block h-auto max-h-[calc(100vh-232px)] w-auto max-w-full select-none object-contain transition-opacity duration-300",
                running && !preview && "opacity-30",
              )}
              draggable={false}
            />
            <CropMarks />
          </div>
        ) : (
          <div className="max-w-sm text-center">
            {connection ? (
              <>
                <p className="font-serif text-[22px] italic text-fg-dim">Nothing developed yet.</p>
                <p className="mt-2 text-fg-faint">
                  Write a prompt, then press Generate or Ctrl Enter. Results land here and in the gallery.
                </p>
              </>
            ) : (
              <p className="text-fg-faint">Add a connection to start generating.</p>
            )}
          </div>
        )}

        {running && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-[5px] bg-panel/90 px-3 py-1.5 text-[13px] text-fg" role="status">
            <span className="text-safelight">{STAGE_LABEL[job.progress?.stage ?? "queued"]}</span>
            {job.progress?.message && job.progress.message !== STAGE_LABEL[job.progress.stage] && (
              <span className="ml-2 text-fg-dim">{job.progress.message}</span>
            )}
          </div>
        )}
      </div>

      {generation && image && (
        <footer className="shrink-0 border-t border-line bg-panel/60 px-5 py-2.5">
          <div className="flex items-center gap-5">
            <dl className="flex min-w-0 flex-1 items-baseline gap-5 text-[13px]">
              <div className="flex gap-1.5">
                <dt className="sr-only">Size</dt>
                <dd className="text-fg">
                  {image.width ?? "?"} × {image.height ?? "?"}
                </dd>
              </div>
              {image.seed !== null && (
                <div className="flex gap-1.5">
                  <dt className="text-fg-faint">Seed</dt>
                  <dd className="text-fg-dim">{image.seed}</dd>
                </div>
              )}
              <div className="flex min-w-0 gap-1.5">
                <dt className="text-fg-faint">Model</dt>
                <dd className="truncate text-fg-dim">{generation.model ?? "default"}</dd>
              </div>
              <div className="flex min-w-0 gap-1.5">
                <dt className="text-fg-faint">Via</dt>
                <dd className="truncate text-fg-dim">{connectionLabel(generation.connectionName, generation.provider)}</dd>
              </div>
              {generation.durationMs !== null && (
                <div className="flex gap-1.5">
                  <dt className="sr-only">Time</dt>
                  <dd className="text-fg-faint">{(generation.durationMs / 1000).toFixed(1)}s</dd>
                </div>
              )}
            </dl>
            <ImageActionBar key={image.id} generation={generation} image={image} />
          </div>

          <div className="mt-1.5 flex items-start gap-4">
            <p className="line-clamp-2 min-w-0 flex-1 font-serif text-[14.5px] leading-snug text-fg-dim" title={generation.prompt}>
              {generation.prompt}
            </p>
            {generation.images.length > 1 && (
              <div className="flex shrink-0 gap-1.5" role="group" aria-label="Images in this generation">
                {generation.images.map((img, i) => (
                  <button
                    key={img.id}
                    type="button"
                    onClick={() => select(generation, i)}
                    aria-label={`Image ${i + 1} of ${generation.images.length}`}
                    aria-current={img.id === image.id}
                    className={cx(
                      "size-10 overflow-hidden rounded-[2px] outline-offset-1",
                      img.id === image.id ? "outline-2 outline-safelight" : "opacity-60 hover:opacity-100",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={imageSrc(img)} alt="" className="size-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </footer>
      )}
    </section>
  );
}
