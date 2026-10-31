"use client";

import { Download, FilePlus2, FolderOpen, Grid3x3, Maximize, Redo2, Save, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { PROJECT_EXT, openSpriteFile, saveProject } from "@/pixel/files";
import { MAX_BRUSH, ZOOM_LEVELS, usePixel } from "@/pixel/store";
import { useApp } from "@/store/app";

import { IconButton, Segmented } from "../ui";
import { ExportDialog, NewSpriteDialog } from "./SpriteDialogs";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function SpriteName() {
  const name = usePixel((s) => s.doc.name);
  const dirty = usePixel((s) => s.dirty);
  const rename = usePixel((s) => s.rename);
  const [editing, setEditing] = useState<string | null>(null);

  if (editing !== null) {
    return (
      <input
        autoFocus
        aria-label="Sprite name"
        value={editing}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={() => {
          rename(editing);
          setEditing(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(null);
        }}
        className="h-7 w-48 rounded-[4px] bg-field px-2 text-[14px] text-fg focus:outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(name)}
      title="Rename"
      className="flex h-7 max-w-56 items-center gap-1.5 truncate rounded-[4px] px-2 text-[14px] text-fg hover:bg-field"
    >
      <span className="truncate">{name}</span>
      {dirty && (
        <span className="size-1.5 shrink-0 rounded-full bg-fg-dim" aria-label="Not saved to a file" title="Not saved to a file" />
      )}
    </button>
  );
}

/** Saves the sprite to a file of the user's choice (Ctrl S). */
export async function saveSprite() {
  const { notify } = useApp.getState();
  try {
    const path = await saveProject(usePixel.getState().doc);
    if (path) {
      usePixel.getState().markSaved();
      notify(`Saved ${path}`);
    }
  } catch (err) {
    notify(`Could not save: ${errorText(err)}`);
  }
}

export function DocBar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<"new" | "export" | null>(null);
  const notify = useApp((s) => s.notify);
  const s = usePixel(
    useShallow((p) => ({
      width: p.doc.width,
      height: p.doc.height,
      tool: p.tool,
      brushSize: p.brushSize,
      shapeFill: p.shapeFill,
      zoom: p.zoom,
      showGrid: p.showGrid,
      canUndo: p.past.length > 0,
      canRedo: p.future.length > 0,
    })),
  );
  const actions = usePixel.getState();
  const brushTool = s.tool === "pencil" || s.tool === "eraser" || s.tool === "line" || s.tool === "rect";

  const zoomStep = (dir: 1 | -1) => {
    const index = ZOOM_LEVELS.findIndex((z) => z >= s.zoom);
    actions.setZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + dir))]);
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
      <SpriteName />
      <span className="mr-2 text-[13px] text-fg-faint">
        {s.width} × {s.height}
      </span>

      <IconButton label="New sprite" onClick={() => setDialog("new")}>
        <FilePlus2 size={15} />
      </IconButton>
      <IconButton label="Open a sprite or a small PNG" onClick={() => fileRef.current?.click()}>
        <FolderOpen size={15} />
      </IconButton>
      <IconButton label="Save sprite (Ctrl S)" onClick={() => void saveSprite()}>
        <Save size={15} />
      </IconButton>
      <IconButton label="Export PNG" onClick={() => setDialog("export")}>
        <Download size={15} />
      </IconButton>
      <input
        ref={fileRef}
        type="file"
        accept={`.${PROJECT_EXT},.json,image/png,image/gif,image/webp`}
        className="hidden"
        aria-label="Sprite file"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            actions.replaceDoc(await openSpriteFile(file));
            notify(`Opened ${file.name}. Undo brings back the previous sprite.`);
          } catch (err) {
            notify(errorText(err));
          }
        }}
      />

      <span aria-hidden className="mx-2 h-5 w-px bg-line" />
      <IconButton label="Undo (Ctrl Z)" onClick={actions.undo} disabled={!s.canUndo}>
        <Undo2 size={15} />
      </IconButton>
      <IconButton label="Redo (Ctrl Shift Z)" onClick={actions.redo} disabled={!s.canRedo}>
        <Redo2 size={15} />
      </IconButton>

      {brushTool && (
        <>
          <span aria-hidden className="mx-2 h-5 w-px bg-line" />
          <label className="flex items-center gap-2 text-[13px] text-fg-dim">
            Size
            <input
              type="range"
              min={1}
              max={MAX_BRUSH}
              value={s.brushSize}
              onChange={(e) => actions.setBrushSize(Number(e.target.value))}
              className="w-24"
            />
            <span className="w-4 text-fg">{s.brushSize}</span>
          </label>
        </>
      )}
      {s.tool === "rect" && (
        <div className="ml-2 w-40">
          <Segmented
            label="Rectangle style"
            value={s.shapeFill ? "fill" : "outline"}
            onChange={(v) => actions.setShapeFill(v === "fill")}
            options={[
              { value: "outline", label: "Outline" },
              { value: "fill", label: "Filled" },
            ]}
          />
        </div>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="Show grid" active={s.showGrid} onClick={actions.toggleGrid}>
          <Grid3x3 size={15} />
        </IconButton>
        <IconButton label="Zoom out" onClick={() => zoomStep(-1)}>
          <ZoomOut size={15} />
        </IconButton>
        <span className="w-10 text-center text-[13px] text-fg-dim">{s.zoom}×</span>
        <IconButton label="Zoom in" onClick={() => zoomStep(1)}>
          <ZoomIn size={15} />
        </IconButton>
        <IconButton label="Fit to view (0)" onClick={actions.fit}>
          <Maximize size={15} />
        </IconButton>
      </div>

      {dialog === "new" && <NewSpriteDialog onClose={() => setDialog(null)} />}
      {dialog === "export" && <ExportDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
