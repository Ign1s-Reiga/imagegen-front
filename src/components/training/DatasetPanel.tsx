"use client";

import { AlertTriangle, Check, Copy, FolderPlus, ImagePlus, MapPin, Sparkles, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useApp, useAssistant } from "@/store/app";
import { imagePath, type Category, type Crop, type DatasetItem, type ImportReport, type Project } from "@/training/api";
import { captioner } from "@/training/caption-assistant";
import { datasetGuidance, hasTrigger } from "@/training/captions";
import { useTraining } from "@/training/store";

import { Button, Dialog, IconButton, Select, TextArea, cx } from "../ui";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "", label: "No category" },
  { value: "face", label: "Face" },
  { value: "upper-body", label: "Upper body" },
  { value: "full-body", label: "Full body" },
];

function describeImport(report: ImportReport): string {
  const parts = [`Added ${report.added} photo${report.added === 1 ? "" : "s"}.`];
  if (report.duplicates.length) {
    parts.push(
      `Skipped ${report.duplicates.length} exact duplicate${report.duplicates.length === 1 ? "" : "s"} (${report.duplicates
        .slice(0, 3)
        .map(([dup, of]) => `${dup} is ${of}`)
        .join(", ")}${report.duplicates.length > 3 ? ", …" : ""}).`,
    );
  }
  if (report.unsupported.length) parts.push(`Skipped ${report.unsupported.length} file(s) that are not JPEG, PNG or WebP.`);
  if (report.unreadable.length) parts.push(`${report.unreadable.length} could not be read and were left out of training.`);
  if (report.withLocation) {
    parts.push(`${report.withLocation} had location data in their EXIF. It stays in your copy and is never uploaded.`);
  }
  return parts.join(" ");
}

export function DatasetPanel({ project }: { project: Project }) {
  const items = useTraining((s) => s.items);
  const importDialog = useTraining((s) => s.importDialog);
  const importFiles = useTraining((s) => s.importFiles);
  const notify = useApp((s) => s.notify);
  const [over, setOver] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (task: () => Promise<ImportReport | null>) => {
    setBusy(true);
    try {
      const report = await task();
      if (report) notify(describeImport(report));
    } catch (err) {
      notify(`Could not add photos: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const included = items.filter((i) => i.included);
  const missingToken = included.filter((i) => i.caption.trim() && !hasTrigger(i.caption, project.triggerToken)).length;
  const guidance = datasetGuidance(items);
  const inspected = items.find((i) => i.id === inspecting) ?? null;

  return (
    <div
      className={cx("min-h-full px-6 py-5", over && "bg-safelight/5 outline-dashed outline-1 -outline-offset-8 outline-safelight")}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) void run(() => importFiles(files));
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void run(() => importDialog(false))}>
          <ImagePlus size={15} />
          Add photos
        </Button>
        <Button disabled={busy} onClick={() => void run(() => importDialog(true))}>
          <FolderPlus size={15} />
          Add a folder
        </Button>
        <span className="text-[13px] text-fg-faint">or drop photos here. They are copied; your originals stay as they are.</span>
        <span className="ml-auto text-[13px] text-fg-dim">
          {included.length} of {items.length} included
        </span>
      </div>

      {items.length > 0 && (
        <section aria-label="Dataset notes" className="mt-4 rounded-[4px] border border-line px-4 py-3 text-[13px] leading-relaxed text-fg-dim">
          <ul className="list-disc space-y-0.5 pl-4">
            {guidance.map((note) => (
              <li key={note}>{note}</li>
            ))}
            {missingToken > 0 && (
              <li className="text-safelight">
                {missingToken} included caption{missingToken === 1 ? " does" : "s do"} not mention {project.triggerToken}. Training uses each
                caption as written.
              </li>
            )}
            <li>
              A photo without a caption trains with the prompt &quot;photo of {project.triggerToken} person&quot;.
            </li>
          </ul>
        </section>
      )}

      {items.length > 0 && <CaptionAssist project={project} />}

      <ul className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} project={project} onInspect={() => setInspecting(item.id)} />
        ))}
      </ul>

      {inspected && <PhotoInspector item={inspected} project={project} onClose={() => setInspecting(null)} />}
    </div>
  );
}

function ItemCard({ item, project, onInspect }: { item: DatasetItem; project: Project; onInspect: () => void }) {
  const patchItem = useTraining((s) => s.patchItem);
  const notify = useApp((s) => s.notify);
  const [draft, setDraft] = useState<string | null>(null);
  const save = (patch: Parameters<typeof patchItem>[1]) => patchItem(item.id, patch).catch((err: unknown) => notify(String(err)));
  const caption = draft ?? item.caption;

  return (
    <li className={cx("flex flex-col rounded-[5px] border bg-panel", item.included ? "border-line" : "border-line opacity-60")}>
      <button type="button" onClick={onInspect} className="relative block aspect-square overflow-hidden rounded-t-[5px] bg-field" aria-label={`Inspect ${item.originalName}`}>
        {item.thumbPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imagePath(item.thumbPath)} alt="" className="size-full object-contain" />
        ) : (
          <span className="flex size-full items-center justify-center p-3 text-center text-[12.5px] text-danger">
            <AlertTriangle size={16} className="mr-1.5 shrink-0" />
            {item.decodeError ?? "No preview"}
          </span>
        )}
        {item.crop && <span className="absolute left-1.5 top-1.5 rounded-[3px] bg-surround/85 px-1.5 text-[11.5px] text-fg">Cropped</span>}
        {item.hasLocation && (
          <span title="Has location data, which is never uploaded" className="absolute right-1.5 top-1.5 rounded-[3px] bg-surround/85 p-0.5 text-fg-dim">
            <MapPin size={12} />
          </span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <div className="flex items-center gap-2 text-[12px] text-fg-faint">
          <span className="min-w-0 flex-1 truncate" title={item.originalName}>
            {item.originalName}
          </span>
          {item.width && item.height && (
            <span className="shrink-0 tabular-nums">
              {item.width}×{item.height}
            </span>
          )}
        </div>
        <TextArea
          aria-label={`Caption for ${item.originalName}`}
          rows={3}
          value={caption}
          placeholder={`photo of ${project.triggerToken} person, …`}
          className="text-[12.5px]"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && draft !== item.caption) void save({ caption: draft, captionSource: "manual" });
            setDraft(null);
          }}
        />
        {item.captionSuggestion && (
          <div className="rounded-[4px] bg-field px-2 py-1.5 text-[12px] leading-snug">
            <p className="text-fg-faint">Suggested</p>
            <p className="text-fg-dim">{item.captionSuggestion}</p>
            <div className="mt-1 flex gap-1">
              <Button size="sm" onClick={() => void save({ caption: item.captionSuggestion!, captionSource: "assistant", captionSuggestion: null })}>
                <Check size={13} />
                Use
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void save({ captionSuggestion: null })}>
                Discard
              </Button>
            </div>
          </div>
        )}
        <div className="mt-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12.5px] text-fg-dim">
            <input
              type="checkbox"
              checked={item.included}
              disabled={Boolean(item.decodeError)}
              onChange={(e) => void save({ included: e.target.checked })}
            />
            Include
          </label>
          <Select
            aria-label="Category"
            value={item.category}
            onChange={(e) => void save({ category: e.target.value as Category })}
            className="ml-auto h-7 w-auto text-[12.5px]"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </li>
  );
}

function CaptionAssist({ project }: { project: Project }) {
  const assistant = useAssistant();
  const items = useTraining((s) => s.items);
  const captioning = useTraining((s) => s.captioning);
  const captionSuggestions = useTraining((s) => s.captionSuggestions);
  const stopCaptioning = useTraining((s) => s.stopCaptioning);
  const acceptSuggestions = useTraining((s) => s.acceptSuggestions);
  const notify = useApp((s) => s.notify);
  const [confirming, setConfirming] = useState(false);
  const [onlyEmpty, setOnlyEmpty] = useState(true);
  const [replaceManual, setReplaceManual] = useState(false);

  const targets = useMemo(
    () => items.filter((i) => i.included && !i.decodeError && (!onlyEmpty || !i.caption.trim())),
    [items, onlyEmpty],
  );
  const pending = items.filter((i) => i.captionSuggestion).length;

  const start = async () => {
    if (!assistant) return;
    setConfirming(false);
    const result = await captionSuggestions(targets, captioner(assistant, project.triggerToken));
    notify(
      `Suggested ${result.done} caption${result.done === 1 ? "" : "s"}${result.failed ? `; ${result.failed} failed (${result.error})` : ""}. Review them before use.`,
    );
  };

  return (
    <section aria-label="Caption suggestions" className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
      {captioning ? (
        <>
          <span className="text-safelight">
            Suggesting captions: {captioning.done + captioning.failed} of {captioning.total}
          </span>
          <Button size="sm" variant="ghost" onClick={stopCaptioning}>
            Stop
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" disabled={!assistant || !targets.length} onClick={() => setConfirming(true)}>
            <Sparkles size={14} />
            Suggest captions
          </Button>
          <label className="flex items-center gap-1.5 text-fg-dim">
            <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} />
            Only photos without a caption
          </label>
          {!assistant && <span className="text-fg-faint">Add a Claude or OpenRouter connection to get suggestions.</span>}
        </>
      )}
      {pending > 0 && !captioning && (
        <span className="ml-auto flex items-center gap-2">
          <span className="text-fg-dim">{pending} suggestion{pending === 1 ? "" : "s"} to review</span>
          <label className="flex items-center gap-1.5 text-fg-dim">
            <input type="checkbox" checked={replaceManual} onChange={(e) => setReplaceManual(e.target.checked)} />
            Replace captions I wrote
          </label>
          <Button
            size="sm"
            onClick={() =>
              acceptSuggestions(replaceManual)
                .then((n) => notify(`Used ${n} suggestion${n === 1 ? "" : "s"}.`))
                .catch((err: unknown) => notify(String(err)))
            }
          >
            Use all suggestions
          </Button>
        </span>
      )}
      {confirming && assistant && (
        <Dialog label="Send photos for captions" onClose={() => setConfirming(false)} className="w-[min(520px,100%)] p-6">
          <h2 className="text-[17px] font-semibold">Send {targets.length} photo{targets.length === 1 ? "" : "s"} to {assistant.connection.name}?</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-fg-dim">
            Each photo is sent to {assistant.connection.name} ({assistant.model}) as a reduced copy without location or camera data,
            and its reply is kept as a suggestion for you to review. The service&apos;s own terms apply to what you send. Nothing is
            sent until you continue.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void start()}>
              Send and suggest
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function PhotoInspector({ item, project, onClose }: { item: DatasetItem; project: Project; onClose: () => void }) {
  const patchItem = useTraining((s) => s.patchItem);
  const deleteItem = useTraining((s) => s.deleteItem);
  const notify = useApp((s) => s.notify);
  const [crop, setCrop] = useState<Crop | null>(item.crop);
  const [cropping, setCropping] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const point = (e: ReactPointerEvent) => {
    const rect = frameRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const changed = JSON.stringify(crop) !== JSON.stringify(item.crop);
  const save = () =>
    patchItem(item.id, { crop })
      .then(() => setCropping(false))
      .catch((err: unknown) => notify(String(err)));

  return (
    <Dialog label={item.originalName} onClose={onClose} fill initialFocus="panel">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-medium">{item.originalName}</h2>
        <span className="text-[12.5px] text-fg-faint">
          {item.width}×{item.height} · SHA-256 {item.sha256.slice(0, 12)}
        </span>
        <IconButton label="Copy full hash" onClick={() => void navigator.clipboard?.writeText(item.sha256)}>
          <Copy size={14} />
        </IconButton>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 items-center justify-center bg-surround p-6">
          {item.decodeError ? (
            <p className="text-danger">{item.decodeError}</p>
          ) : (
            <div
              ref={frameRef}
              className={cx("relative max-h-full", cropping && "cursor-crosshair touch-none")}
              onPointerDown={(e) => {
                if (!cropping) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                start.current = point(e);
                setCrop(null);
              }}
              onPointerMove={(e) => {
                if (!cropping || !start.current) return;
                const p = point(e);
                const s = start.current;
                setCrop({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) });
              }}
              onPointerUp={() => {
                start.current = null;
                setCrop((c) => (c && c.width > 0.02 && c.height > 0.02 ? c : null));
              }}
            >
              {/* The browser applies EXIF orientation, as the training copy does. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imagePath(item.path)} alt={item.originalName} draggable={false} className="block max-h-[calc(100vh-12rem)] max-w-full select-none" />
              {crop && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute border-2 border-safelight shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                  style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
                />
              )}
            </div>
          )}
        </div>
        <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line p-5 text-[13px]">
          <section>
            <h3 className="font-medium text-fg-dim">Crop</h3>
            <p className="mt-1 leading-snug text-fg-faint">
              Optional. Training uses the whole photo unless you crop it here, and the trainer&apos;s aspect-ratio buckets keep
              its shape. The original is never changed, so a crop can be cleared at any time.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cropping ? (
                <>
                  <Button size="sm" variant="primary" disabled={!changed} onClick={() => void save()}>
                    Save crop
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCrop(item.crop);
                      setCropping(false);
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" disabled={Boolean(item.decodeError)} onClick={() => setCropping(true)}>
                  {item.crop ? "Change crop" : "Crop"}
                </Button>
              )}
              {item.crop && !cropping && (
                <Button size="sm" variant="ghost" onClick={() => patchItem(item.id, { crop: null }).then(() => setCrop(null))}>
                  Clear crop
                </Button>
              )}
            </div>
            {cropping && <p className="mt-1.5 text-fg-faint">Drag across the photo to draw the crop.</p>}
          </section>
          <section>
            <h3 className="font-medium text-fg-dim">Caption</h3>
            <p className="mt-1 leading-snug text-fg">{item.caption || <span className="text-fg-faint">None yet. Edit it on the photo&apos;s card.</span>}</p>
            {item.caption && !hasTrigger(item.caption, project.triggerToken) && (
              <p className="mt-1 text-safelight">Does not mention {project.triggerToken}.</p>
            )}
          </section>
          <section className="text-fg-faint">
            <p>Orientation from EXIF: {item.orientation === 1 ? "none" : `tag ${item.orientation}, applied`}</p>
            {item.hasLocation && <p>Has GPS data. Training copies are re-encoded without any metadata.</p>}
          </section>
          <Button
            variant="danger"
            className="mt-auto self-start"
            onClick={() =>
              deleteItem(item.id)
                .then(onClose)
                .catch((err: unknown) => notify(String(err)))
            }
          >
            <Trash2 size={14} />
            Remove from project
          </Button>
        </aside>
      </div>
    </Dialog>
  );
}
