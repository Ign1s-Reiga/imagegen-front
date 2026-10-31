"use client";

import { ArrowLeftRight, Plus } from "lucide-react";
import { useState } from "react";

import { PALETTE_PRESETS } from "@/pixel/color";
import { usePixel } from "@/pixel/store";

import { IconButton, Select, cx, useFieldId } from "../ui";

export function PalettePanel() {
  const palette = usePixel((s) => s.doc.palette);
  const primary = usePixel((s) => s.primary);
  const secondary = usePixel((s) => s.secondary);
  const { setPrimary, setSecondary, swapColors, addColor, removeColor, replaceColor, setPalette, addUsedColors } =
    usePixel.getState();
  const [editing, setEditing] = useState<number | null>(null);
  const presetId = useFieldId("preset");

  const editIndex = editing !== null && editing < palette.length ? editing : null;

  return (
    <section aria-label="Palette" className="border-b border-line px-3 pb-3 pt-2.5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[13px] font-medium text-fg-dim">Palette</h2>
        <span className="text-[12.5px] text-fg-faint">{palette.length} colours</span>
      </div>

      <div className="mb-3 flex items-center gap-3">
        <div className="relative size-11 shrink-0" aria-label={`Colours: primary ${primary}, secondary ${secondary}`}>
          <label className="absolute bottom-0 right-0 size-7 cursor-pointer rounded-[3px] ring-1 ring-line-strong" style={{ backgroundColor: secondary }} title="Secondary colour (right click)">
            <input type="color" value={secondary} onChange={(e) => setSecondary(e.target.value)} className="sr-only" aria-label="Secondary colour" />
          </label>
          <label className="absolute left-0 top-0 size-7 cursor-pointer rounded-[3px] ring-1 ring-fg-dim" style={{ backgroundColor: primary }} title="Primary colour (left click)">
            <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} className="sr-only" aria-label="Primary colour" />
          </label>
        </div>
        <IconButton label="Swap colours (X)" onClick={swapColors}>
          <ArrowLeftRight size={14} />
        </IconButton>
        <IconButton label="Add the primary colour to the palette" onClick={() => addColor(primary)} disabled={palette.includes(primary.toLowerCase())}>
          <Plus size={15} />
        </IconButton>
      </div>

      {palette.length > 0 ? (
        <div className="grid grid-cols-8 gap-1" role="listbox" aria-label="Palette colours">
          {palette.map((c, i) => (
            <button
              key={`${c}-${i}`}
              type="button"
              role="option"
              aria-selected={c === primary.toLowerCase()}
              title={`${c}. Click: primary, right click: secondary, double click: edit`}
              onClick={() => setPrimary(c)}
              onDoubleClick={() => setEditing(i)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSecondary(c);
              }}
              className={cx(
                "aspect-square rounded-[2px] ring-offset-1 ring-offset-panel",
                c === primary.toLowerCase() ? "ring-2 ring-fg" : c === secondary.toLowerCase() ? "ring-1 ring-fg-dim" : "",
                editIndex === i && "outline outline-safelight",
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      ) : (
        <p className="text-[13px] leading-snug text-fg-faint">
          No colours yet. Add the primary colour, pick a preset, or let the AI choose them.
        </p>
      )}

      {editIndex !== null && (
        <div className="mt-2 flex items-center gap-2 text-[13px]">
          <label className="flex flex-1 items-center gap-2 text-fg-dim">
            <input
              type="color"
              value={palette[editIndex]}
              onChange={(e) => replaceColor(editIndex, e.target.value)}
              className="h-7 w-9 cursor-pointer rounded-[3px] bg-transparent"
              aria-label="Edit colour"
            />
            {palette[editIndex]}
          </label>
          <button type="button" className="text-danger hover:underline" onClick={() => {
              removeColor(editIndex);
              setEditing(null);
            }}>
            Remove
          </button>
          <button type="button" className="text-fg-dim hover:text-fg" onClick={() => setEditing(null)}>
            Done
          </button>
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5">
        <Select
          id={presetId}
          aria-label="Replace the palette with a preset"
          value=""
          onChange={(e) => {
            const preset = PALETTE_PRESETS.find((p) => p.id === e.target.value);
            if (preset) setPalette(preset.colors);
          }}
          className="h-7 flex-1 text-[13px]"
        >
          <option value="" disabled>
            Load a preset
          </option>
          {PALETTE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <button
          type="button"
          onClick={addUsedColors}
          className="h-7 shrink-0 rounded-[4px] px-2 text-[13px] text-fg-dim hover:bg-raised hover:text-fg"
          title="Add every colour the sprite uses to the palette"
        >
          Add used
        </button>
      </div>
    </section>
  );
}
