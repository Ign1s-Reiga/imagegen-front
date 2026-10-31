"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { PALETTE_PRESETS } from "@/pixel/color";
import { MAX_SIDE, clampSide } from "@/pixel/doc";
import { exportPng, type ExportOptions } from "@/pixel/files";
import { newSprite, usePixel } from "@/pixel/store";
import { useApp } from "@/store/app";

import { Button, Field, NumberInput, Segmented, Select, TextInput, cx, useFieldId } from "../ui";

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, select, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/55" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="w-[400px] rounded-[6px] bg-panel p-5 shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
        <h2 className="mb-4 text-[15px] font-medium text-fg">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const SIZES = [16, 24, 32, 48, 64, 96, 128];

export function NewSpriteDialog({ onClose }: { onClose: () => void }) {
  const replaceDoc = usePixel((s) => s.replaceDoc);
  const dirty = usePixel((s) => s.dirty);
  const [width, setWidth] = useState(32);
  const [height, setHeight] = useState(32);
  const [preset, setPreset] = useState(PALETTE_PRESETS[0].id);
  const [name, setName] = useState("Untitled sprite");
  const nameId = useFieldId("sprite-name");
  const paletteId = useFieldId("palette");

  const create = () => {
    replaceDoc(newSprite(clampSide(width), clampSide(height), preset, name.trim() || "Untitled sprite"));
    onClose();
  };

  return (
    <Dialog title="New sprite" onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <Field label="Name" htmlFor={nameId}>
          <TextInput id={nameId} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Size" help={`Up to ${MAX_SIDE}×${MAX_SIDE} pixels.`}>
          <div className="grid grid-cols-7 gap-1">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={width === s && height === s}
                onClick={() => {
                  setWidth(s);
                  setHeight(s);
                }}
                className={cx(
                  "h-8 rounded-[4px] text-[13px] transition-colors",
                  width === s && height === s ? "bg-raised text-fg" : "text-fg-dim hover:bg-field hover:text-fg",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <NumberInput ariaLabel="Width" value={width} onChange={(v) => setWidth(v ?? 32)} min={1} max={MAX_SIDE} />
            <span className="text-fg-faint">×</span>
            <NumberInput ariaLabel="Height" value={height} onChange={(v) => setHeight(v ?? 32)} min={1} max={MAX_SIDE} />
          </div>
        </Field>
        <Field label="Palette" htmlFor={paletteId}>
          <Select id={paletteId} value={preset} onChange={(e) => setPreset(e.target.value)}>
            {PALETTE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.colors.length} colours)
              </option>
            ))}
            <option value="">Empty (build it as you go)</option>
          </Select>
          <div className="flex h-3 overflow-hidden rounded-[2px]">
            {(PALETTE_PRESETS.find((p) => p.id === preset)?.colors ?? []).map((c) => (
              <span key={c} className="flex-1" style={{ backgroundColor: c }} />
            ))}
          </div>
        </Field>
        {dirty && <p className="text-[13px] text-fg-dim">The current sprite is not saved to a file. Undo brings it back.</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const SCALES = [1, 2, 4, 8, 16];

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const doc = usePixel((s) => s.doc);
  const frameId = usePixel((s) => s.frameId);
  const notify = useApp((s) => s.notify);
  const [options, setOptions] = useState<ExportOptions>({
    what: doc.frames.length > 1 ? "sheet" : "frame",
    scale: doc.width <= 64 ? 8 : 4,
    columns: doc.frames.length,
  });
  const [busy, setBusy] = useState(false);
  const columnsId = useFieldId("columns");

  const cols = Math.max(1, Math.min(options.columns, doc.frames.length));
  const rows = Math.ceil(doc.frames.length / cols);
  const outW = (options.what === "sheet" ? doc.width * cols : doc.width) * options.scale;
  const outH = (options.what === "sheet" ? doc.height * rows : doc.height) * options.scale;

  const run = async () => {
    setBusy(true);
    try {
      const path = await exportPng(doc, frameId, options);
      if (path) {
        notify(`Exported ${path}`);
        onClose();
      }
    } catch (err) {
      notify(`Could not export: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Export PNG" onClose={onClose}>
      <div className="space-y-4">
        <Segmented
          label="What to export"
          value={options.what}
          onChange={(what) => setOptions({ ...options, what })}
          options={[
            { value: "frame", label: "Current frame" },
            { value: "sheet", label: `Sprite sheet (${doc.frames.length})`, disabled: doc.frames.length < 2 },
          ]}
        />
        <Field label="Scale" help="Each sprite pixel becomes a square of this many pixels.">
          <div className="grid grid-cols-5 gap-1">
            {SCALES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={options.scale === s}
                onClick={() => setOptions({ ...options, scale: s })}
                className={cx(
                  "h-8 rounded-[4px] text-[13px] transition-colors",
                  options.scale === s ? "bg-raised text-fg" : "text-fg-dim hover:bg-field hover:text-fg",
                )}
              >
                {s}×
              </button>
            ))}
          </div>
        </Field>
        {options.what === "sheet" && (
          <Field label="Frames per row" htmlFor={columnsId}>
            <NumberInput
              id={columnsId}
              value={options.columns}
              onChange={(v) => setOptions({ ...options, columns: Math.max(1, Math.min(doc.frames.length, v ?? 1)) })}
              min={1}
              max={doc.frames.length}
            />
          </Field>
        )}
        <p className="text-[13px] text-fg-dim">
          {outW} × {outH} pixels
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            Export
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
