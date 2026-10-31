"use client";

import { ArrowDownToLine, ChevronDown, ChevronUp, Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { MAX_LAYERS, celPixels } from "@/pixel/doc";
import { usePixel } from "@/pixel/store";

import { IconButton, cx } from "../ui";
import { PixelThumb } from "./PixelThumb";

export function LayersPanel() {
  const doc = usePixel((s) => s.doc);
  const layerId = usePixel((s) => s.layerId);
  const frameId = usePixel((s) => s.frameId);
  const { selectLayer, addLayer, duplicateLayer, removeLayer, moveLayer, mergeDown, updateLayer } = usePixel.getState();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const index = doc.layers.findIndex((l) => l.id === layerId);
  const layer = doc.layers[index];
  const topDown = [...doc.layers].reverse();

  return (
    <section aria-label="Layers" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1.5 pt-2.5">
        <h2 className="text-[13px] font-medium text-fg-dim">Layers</h2>
        <div className="flex items-center">
          <IconButton label="New layer" onClick={addLayer} disabled={doc.layers.length >= MAX_LAYERS}>
            <Plus size={15} />
          </IconButton>
          <IconButton label="Duplicate layer" onClick={duplicateLayer} disabled={doc.layers.length >= MAX_LAYERS}>
            <Copy size={14} />
          </IconButton>
          <IconButton label="Move layer up" onClick={() => moveLayer(layerId, 1)} disabled={index >= doc.layers.length - 1}>
            <ChevronUp size={15} />
          </IconButton>
          <IconButton label="Move layer down" onClick={() => moveLayer(layerId, -1)} disabled={index <= 0}>
            <ChevronDown size={15} />
          </IconButton>
          <IconButton label="Merge into the layer below" onClick={() => mergeDown(layerId)} disabled={index <= 0}>
            <ArrowDownToLine size={14} />
          </IconButton>
          <IconButton label="Delete layer" onClick={() => removeLayer(layerId)} disabled={doc.layers.length <= 1}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5" role="listbox" aria-label="Layers, top first">
        {topDown.map((l) => {
          const current = l.id === layerId;
          return (
            <li key={l.id}>
              <div
                role="option"
                aria-selected={current}
                tabIndex={0}
                onClick={() => selectLayer(l.id)}
                onKeyDown={(e) => e.key === "Enter" && selectLayer(l.id)}
                className={cx(
                  "group flex h-10 cursor-default items-center gap-2 rounded-[4px] px-1.5",
                  current ? "bg-raised" : "hover:bg-field",
                )}
              >
                <button
                  type="button"
                  aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                  title={l.visible ? "Hide" : "Show"}
                  onClick={(e) => {
                    e.stopPropagation();
                    updateLayer(l.id, { visible: !l.visible });
                  }}
                  className={cx("flex size-6 shrink-0 items-center justify-center rounded-[3px] hover:text-fg", l.visible ? "text-fg-dim" : "text-fg-faint")}
                >
                  {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <PixelThumb pixels={celPixels(doc, l.id, frameId)} width={doc.width} height={doc.height} className={cx("size-7 shrink-0 rounded-[2px]", !l.visible && "opacity-40")} />
                {renaming?.id === l.id ? (
                  <input
                    autoFocus
                    aria-label="Layer name"
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: l.id, name: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => {
                      const name = renaming.name.trim();
                      if (name && name !== l.name) updateLayer(l.id, { name });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    className="h-7 min-w-0 flex-1 rounded-[3px] bg-field px-1.5 text-[13px] text-fg focus:outline-none"
                  />
                ) : (
                  <span
                    className={cx("min-w-0 flex-1 truncate text-[13px]", current ? "text-fg" : "text-fg-dim")}
                    onDoubleClick={() => setRenaming({ id: l.id, name: l.name })}
                    title="Double click to rename"
                  >
                    {l.name}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {layer && (
        <div className="border-t border-line px-3 py-2 text-[13px] text-fg-dim">
          <label className="flex items-center gap-2">
            Opacity
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(layer.opacity * 100)}
              onChange={(e) => updateLayer(layer.id, { opacity: Number(e.target.value) / 100 }, true)}
              className="min-w-0 flex-1"
              aria-label={`Opacity of ${layer.name}`}
            />
            <span className="w-9 text-right text-fg">{Math.round(layer.opacity * 100)}%</span>
          </label>
        </div>
      )}
    </section>
  );
}
