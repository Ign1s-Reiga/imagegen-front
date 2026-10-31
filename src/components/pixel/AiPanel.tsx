"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { aiSupport, type AiOp, type Candidate } from "@/pixel/ai";
import { composite } from "@/pixel/doc";
import { pasteRegion } from "@/pixel/raster";
import { usePixel, type ApplyTarget } from "@/pixel/store";
import { connectionLabel, provider } from "@/providers/registry";
import { activeConnection, activeWorkflow, capabilitiesFor, useApp } from "@/store/app";

import { Button, Field, NumberInput, Segmented, Select, TextArea, cx, useFieldId } from "../ui";
import { PixelThumb } from "./PixelThumb";

const RUN_LABEL: Record<AiOp, string> = { create: "Create sprite", edit: "Change area", vary: "Make variations" };
const STAGE_LABEL = { uploading: "Uploading", queued: "Queued", running: "Generating", downloading: "Downloading" } as const;
const COLOUR_COUNTS = [4, 8, 16, 24, 32];

function useElapsed(since: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

function Amount({ value, onChange, help }: { value: number; onChange: (v: number) => void; help: string }) {
  return (
    <Field label="Change amount" aside={<span className="text-[13px] text-fg-dim">{Math.round(value * 100)}%</span>} help={help}>
      <input type="range" min={0.1} max={1} step={0.05} value={value} aria-label="Change amount" onChange={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

function PaletteChoice({
  keep,
  colors,
  onChange,
}: {
  keep: boolean;
  colors: number;
  onChange: (patch: { keepPalette?: boolean; colors?: number }) => void;
}) {
  const colorsId = useFieldId("colours");
  return (
    <Field label="Colours">
      <Segmented
        label="Colours"
        value={keep ? "keep" : "new"}
        onChange={(v) => onChange({ keepPalette: v === "keep" })}
        options={[
          { value: "keep", label: "Sprite palette" },
          { value: "new", label: "New palette" },
        ]}
      />
      {!keep && (
        <div className="flex items-center gap-2 text-[13px] text-fg-dim">
          <label htmlFor={colorsId}>Pick</label>
          <Select id={colorsId} value={String(colors)} onChange={(e) => onChange({ colors: Number(e.target.value) })} className="h-7 w-20">
            {COLOUR_COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <span>colours from the result</span>
        </div>
      )}
    </Field>
  );
}

function CandidateCard({ candidate }: { candidate: Candidate }) {
  const doc = usePixel((s) => s.doc);
  const frameId = usePixel((s) => s.frameId);
  const { applyCandidate, dismissCandidate } = usePixel.getState();
  const notify = useApp((s) => s.notify);
  const fits = candidate.width === doc.width && candidate.height === doc.height;

  // Edits preview as they would look applied to the current frame.
  const preview = useMemo(() => {
    if (!candidate.region || !fits) return candidate.pixels;
    return pasteRegion(composite(doc, frameId), candidate.pixels, doc.width, candidate.region);
  }, [candidate, doc, frameId, fits]);

  const apply = (target: ApplyTarget) => {
    const problem = applyCandidate(candidate.id, target);
    if (problem) notify(problem);
  };

  const action = (label: string, target: ApplyTarget, title: string) => (
    <button
      type="button"
      title={title}
      onClick={() => apply(target)}
      disabled={!fits}
      className="h-6 rounded-[3px] px-1.5 text-[12.5px] text-fg-dim hover:bg-raised hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );

  return (
    <li className="group relative rounded-[4px] bg-field/60 p-1.5">
      <PixelThumb
        pixels={preview}
        width={candidate.width}
        height={candidate.height}
        className="aspect-square w-full rounded-[2px]"
        label={`AI result: ${candidate.prompt}`}
      />
      <button
        type="button"
        aria-label="Dismiss this result"
        onClick={() => dismissCandidate(candidate.id)}
        className="absolute right-2.5 top-2.5 hidden size-6 items-center justify-center rounded-[3px] bg-panel/85 text-fg-dim hover:text-fg group-hover:flex group-focus-within:flex"
      >
        <X size={13} />
      </button>
      {candidate.newPalette && (
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-[1px]" title="New colours, added to the palette when applied">
          {candidate.newPalette.map((c) => (
            <span key={c} className="flex-1" style={{ backgroundColor: c }} />
          ))}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-0.5">
        {!fits ? (
          <span className="px-1 text-[12px] text-fg-faint">Made for another sprite size</span>
        ) : candidate.op === "edit" ? (
          action("Apply", "region", "Replace the selected area of the current layer")
        ) : (
          <>
            {action("New layer", "layer", "Add as a new layer in this frame")}
            {action("New frame", "frame", "Add as a new frame after this one")}
            {action("Replace", "replace", "Replace the current layer in this frame")}
          </>
        )}
      </div>
    </li>
  );
}

export function AiPanel() {
  const connection = useApp(activeConnection);
  const workflow = useApp(activeWorkflow);
  const model = useApp((s) => s.form.model);
  const caps = capabilitiesFor(connection, workflow);
  const tab = usePixel((s) => s.aiTab);
  const ai = usePixel((s) => s.ai);
  const job = usePixel((s) => s.aiJob);
  const error = usePixel((s) => s.aiError);
  const candidates = usePixel((s) => s.candidates);
  const selection = usePixel((s) => s.selection);
  const width = usePixel((s) => s.doc.width);
  const height = usePixel((s) => s.doc.height);
  const { setAiTab, setAi, runAi, cancelAi, dismissAiError } = usePixel.getState();
  const elapsed = useElapsed(job?.startedAt);
  const promptId = useFieldId("pixel-prompt");
  const countId = useFieldId("pixel-count");

  const support = aiSupport(caps);
  const blocked = support[tab];
  const maxCount = caps?.maxCount ?? 1;
  const settings = ai[tab];

  if (!connection) {
    return (
      <aside className="flex w-[320px] shrink-0 flex-col justify-center gap-3 border-r border-line bg-panel px-6">
        <p className="text-fg">No backend connected yet.</p>
        <p className="text-fg-dim">The AI tools use the same connections as Generate. You can still draw by hand.</p>
        <Link
          href="/connections"
          className="inline-flex h-8 items-center self-start rounded-[4px] bg-safelight px-3 font-semibold text-safelight-ink hover:bg-safelight-strong"
        >
          Add a connection
        </Link>
      </aside>
    );
  }

  const placeholder =
    tab === "create" ? "A knight with a blue shield, side view" : tab === "edit" ? "Give the knight a red cape" : "The same knight, mid-stride";
  const promptLabel = tab === "create" ? "Sprite" : tab === "edit" ? "Change" : "Sprite and what to vary";

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-r border-line bg-panel" aria-label="AI">
      <div className="space-y-4 border-b border-line px-4 pb-4 pt-3">
        <Segmented
          label="AI tool"
          value={tab}
          onChange={setAiTab}
          options={[
            { value: "create", label: "Create" },
            { value: "edit", label: "Edit area" },
            { value: "vary", label: "Variations" },
          ]}
        />

        <Field label={promptLabel} htmlFor={promptId}>
          <TextArea
            id={promptId}
            rows={4}
            value={settings.prompt}
            onChange={(e) => setAi(tab, { prompt: e.target.value })}
            placeholder={placeholder}
            className="font-serif text-[15.5px] leading-[1.45]"
          />
        </Field>

        {tab === "create" && (
          <>
            <PaletteChoice keep={ai.create.keepPalette} colors={ai.create.colors} onChange={(p) => setAi("create", p)} />
            <label className="flex items-center gap-2 text-[13px] text-fg-dim">
              <input
                type="checkbox"
                checked={ai.create.removeBackground}
                onChange={(e) => setAi("create", { removeBackground: e.target.checked })}
                className="accent-safelight"
              />
              Make the background transparent
            </label>
          </>
        )}

        {tab === "edit" && (
          <>
            <p className={cx("text-[13px] leading-snug", selection ? "text-fg-dim" : "text-fg-faint")}>
              {selection
                ? `Changes the selected ${selection.w}×${selection.h} area of the current layer.`
                : "Select the area to change first, with the selection tool (M)."}
            </p>
            {caps && !caps.mask && caps.img2img && (
              <Amount
                value={ai.edit.strength}
                onChange={(strength) => setAi("edit", { strength })}
                help="This backend cannot mask, so the whole sprite is redrawn and only the selected area is kept."
              />
            )}
          </>
        )}

        {tab === "vary" && (
          <>
            <Amount
              value={ai.vary.strength}
              onChange={(strength) => setAi("vary", { strength })}
              help="Low keeps the sprite's shapes; high follows the description."
            />
            <PaletteChoice keep={ai.vary.keepPalette} colors={ai.vary.colors} onChange={(p) => setAi("vary", p)} />
          </>
        )}

        {tab !== "edit" && maxCount > 1 && (
          <Field label="Results" htmlFor={countId}>
            <NumberInput
              id={countId}
              value={Math.min(tab === "create" ? ai.create.count : ai.vary.count, maxCount)}
              onChange={(v) => setAi(tab, { count: Math.max(1, Math.min(maxCount, v ?? 1)) })}
              min={1}
              max={Math.min(4, maxCount)}
            />
          </Field>
        )}

        {error && (
          <div role="alert" className="max-h-32 overflow-y-auto rounded-[4px] bg-danger/10 px-3 py-2 text-[13px] leading-snug text-danger">
            <p>{error}</p>
            <button type="button" onClick={dismissAiError} className="mt-1 text-fg-dim hover:text-fg">
              Dismiss
            </button>
          </div>
        )}

        {job ? (
          <div>
            <div className="flex items-center gap-2">
              <Button className="h-10 flex-1" onClick={cancelAi}>
                Cancel
              </Button>
              <span className="w-12 text-right text-[13px] text-fg-dim">{elapsed}s</span>
            </div>
            <p className="mt-2 text-[13px] text-fg-dim" role="status">
              <span className="text-safelight">{STAGE_LABEL[job.progress?.stage ?? "queued"]}</span>
              {job.progress?.message && job.progress.message !== STAGE_LABEL[job.progress.stage] && (
                <span className="ml-2">{job.progress.message}</span>
              )}
            </p>
            <div className="mt-1.5 h-0.5 overflow-hidden bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress?.fraction !== undefined ? Math.round(job.progress.fraction * 100) : undefined}>
              {job.progress?.fraction !== undefined ? (
                <div className="h-full bg-safelight transition-[width] duration-300" style={{ width: `${Math.max(2, job.progress.fraction * 100)}%` }} />
              ) : (
                <div className="h-full w-2/5 bg-safelight" style={{ animation: "indeterminate 1.4s ease-in-out infinite" }} />
              )}
            </div>
          </div>
        ) : (
          <Button
            variant="primary"
            className="h-10 w-full rounded-[6px] text-[15px]"
            onClick={() => void runAi()}
            disabled={!!blocked || (tab === "edit" && !selection)}
            title={blocked ?? undefined}
          >
            {RUN_LABEL[tab]}
            <kbd className="ml-1 font-sans text-[12px] font-medium opacity-60">Ctrl Enter</kbd>
          </Button>
        )}
        {blocked && <p className="text-[13px] leading-snug text-fg-faint">{blocked}</p>}

        <p className="text-[12.5px] leading-snug text-fg-faint">
          {connectionLabel(connection.name, connection.kind)}, {model || (workflow ? workflow.name : provider(connection.kind).defaultModel(connection.config)) || "default model"}.
          Results are snapped to {width}×{height} pixels; the raw images also go to the gallery. Model and settings come from{" "}
          <Link href="/" className="text-fg-dim underline-offset-2 hover:text-fg hover:underline">
            Generate
          </Link>
          .
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {candidates.length ? (
          <ul className="grid grid-cols-2 gap-2" aria-label="AI results">
            {candidates.map((c) => (
              <CandidateCard key={c.id} candidate={c} />
            ))}
          </ul>
        ) : (
          <p className="px-1 text-[13px] leading-snug text-fg-faint">
            Results appear here. Add them as a layer or a frame, or use them to replace what is there.
          </p>
        )}
      </div>
    </aside>
  );
}
