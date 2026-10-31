"use client";

import { ArrowLeftRight, Plus } from "lucide-react";
import { useState } from "react";

import { PALETTE_PRESETS } from "@/pixel/color";
import { usePixel } from "@/pixel/store";

import { IconButton, Select, cx, useFieldId } from "../ui";
import { ColorPicker, HexInput } from "./ColorPicker";

type Slot = "primary" | "secondary";

const EDITING = "outline-2 outline-offset-1 outline-safelight";

export function PalettePanel() {
  const palette = usePixel((s) => s.doc.palette);
  const primary = usePixel((s) => s.primary);
  const secondary = usePixel((s) => s.secondary);
  const { setPrimary, setSecondary, swapColors, addColor, removeColor, replaceColor, setPalette, addUsedColors } =
    usePixel.getState();
  // The picker edits the primary or secondary colour, or a palette entry after a double click.
  const [slot, setSlot] = useState<Slot>("primary");
  const [editing, setEditing] = useState<number | null>(null);
  const presetId = useFieldId("preset");

  const editIndex = editing !== null && editing < palette.length ? editing : null;
  const color = (editIndex !== null ? palette[editIndex] : slot === "primary" ? primary : secondary).toLowerCase();
  const setColor = (hex: string) => {
    if (editIndex !== null) replaceColor(editIndex, hex);
    else if (slot === "primary") setPrimary(hex);
    else setSecondary(hex);
  };
  const editSlot = (next: Slot) => {
    setSlot(next);
    setEditing(null);
  };
  const editingSlot = (s: Slot) => editIndex === null && slot === s;

  return (
    <>
      <section aria-label="Colour" className="border-b border-line px-3 pb-3 pt-2.5">
        <div className="mb-2 flex h-5 items-center justify-between gap-2">
          <h2 className="text-[13px] font-medium text-fg-dim">Colour</h2>
          {editIndex !== null ? (
            <div className="flex items-center gap-2.5 text-[12.5px]">
              <span className="text-fg-faint">Palette colour {editIndex + 1}</span>
              <button
                type="button"
                className="text-danger hover:underline"
                onClick={() => {
                  removeColor(editIndex);
                  setEditing(null);
                }}
              >
                Remove
              </button>
              <button type="button" className="text-fg-dim hover:text-fg" onClick={() => setEditing(null)}>
                Done
              </button>
            </div>
          ) : (
            <span className="text-[12.5px] text-fg-faint">{slot === "primary" ? "Primary" : "Secondary"}</span>
          )}
        </div>

        <div className="mb-2.5 flex items-center gap-1">
          <div className="relative mr-1 size-11 shrink-0">
            <button
              type="button"
              aria-label={`Secondary colour ${secondary}`}
              aria-pressed={editingSlot("secondary")}
              title="Secondary colour (right click). Click to edit"
              onClick={() => editSlot("secondary")}
              className={cx("absolute bottom-0 right-0 size-7 rounded-[3px] ring-1 ring-line-strong", editingSlot("secondary") && EDITING)}
              style={{ backgroundColor: secondary }}
            />
            <button
              type="button"
              aria-label={`Primary colour ${primary}`}
              aria-pressed={editingSlot("primary")}
              title="Primary colour (left click). Click to edit"
              onClick={() => editSlot("primary")}
              className={cx("absolute left-0 top-0 size-7 rounded-[3px] ring-1 ring-fg-dim", editingSlot("primary") && EDITING)}
              style={{ backgroundColor: primary }}
            />
          </div>
          <IconButton label="Swap colours (X)" onClick={swapColors}>
            <ArrowLeftRight size={14} />
          </IconButton>
          <IconButton
            label="Add this colour to the palette"
            onClick={() => addColor(color)}
            disabled={editIndex !== null || palette.includes(color)}
          >
            <Plus size={15} />
          </IconButton>
          <HexInput value={color} onChange={setColor} className="ml-1 flex-1" />
        </div>

        <ColorPicker
          value={color}
          onChange={setColor}
          label={editIndex !== null ? `Palette colour ${editIndex + 1}` : slot === "primary" ? "Primary colour" : "Secondary colour"}
        />
      </section>

      <section aria-label="Palette" className="border-b border-line px-3 pb-3 pt-2.5">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-medium text-fg-dim">Palette</h2>
          <span className="text-[12.5px] text-fg-faint">{palette.length} colours</span>
        </div>

        {palette.length > 0 ? (
          // Padding keeps the selection rings of edge swatches inside the scroll area.
          <div className="-m-[3px] max-h-[150px] overflow-y-auto p-[3px]">
            <div className="grid grid-cols-8 gap-1" role="listbox" aria-label="Palette colours">
              {palette.map((c, i) => (
                <button
                  key={`${c}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={c === primary.toLowerCase()}
                  title={`${c}. Click: primary, right click: secondary, double click: edit`}
                  onClick={() => {
                    setPrimary(c);
                    editSlot("primary");
                  }}
                  onDoubleClick={() => setEditing(i)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSecondary(c);
                    editSlot("secondary");
                  }}
                  className={cx(
                    "aspect-square rounded-[2px] ring-offset-1 ring-offset-panel",
                    c === primary.toLowerCase() ? "ring-2 ring-fg" : c === secondary.toLowerCase() ? "ring-1 ring-fg-dim" : "",
                    editIndex === i && EDITING,
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[13px] leading-snug text-fg-faint">
            No colours yet. Add the colour above, pick a preset, or let the AI choose them.
          </p>
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
    </>
  );
}
