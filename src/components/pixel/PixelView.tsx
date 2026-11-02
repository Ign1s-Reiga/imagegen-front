"use client";

import { useEffect } from "react";

import { MAX_BRUSH, ZOOM_LEVELS, usePixel, type Tool } from "@/pixel/store";

import { isModalOpen } from "../ui";
import { AiPanel } from "./AiPanel";
import { DocBar, saveSprite } from "./DocBar";
import { LayersPanel } from "./LayersPanel";
import { PalettePanel } from "./PalettePanel";
import { PixelCanvas, isTyping } from "./PixelCanvas";
import { Timeline } from "./Timeline";
import { TOOLS, ToolRail } from "./ToolRail";

const TOOL_KEYS = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.tool])) as Record<string, Tool>;

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Under a dialog (New sprite, Export PNG) the sprite is out of sight, so
      // nothing here runs: not the AI, a save, an undo or a tool key.
      if (isModalOpen()) return;
      const s = usePixel.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // In the assistant tab, Enter in the message box sends instead.
      if (mod && key === "enter" && s.aiPanel === "tools") {
        e.preventDefault();
        void s.runAi();
        return;
      }
      if (mod && key === "s") {
        e.preventDefault();
        void saveSprite();
        return;
      }
      if (isTyping(e.target) || e.defaultPrevented) return;

      if (mod) {
        if (key === "z") s[e.shiftKey ? "redo" : "undo"]();
        else if (key === "y") s.redo();
        else if (key === "a") s.selectAll();
        else if (key === "d") s.setSelection(null);
        else return;
        e.preventDefault();
        return;
      }
      if (e.altKey) return;

      if (TOOL_KEYS[key]) s.setTool(TOOL_KEYS[key]);
      else if (key === "x") s.swapColors();
      else if (key === "[") s.setBrushSize(s.brushSize - 1);
      else if (key === "]") s.setBrushSize(Math.min(MAX_BRUSH, s.brushSize + 1));
      else if (key === "0") s.fit();
      else if (key === "+" || key === "=") s.setZoom(ZOOM_LEVELS.find((z) => z > s.zoom) ?? s.zoom);
      else if (key === "-") s.setZoom([...ZOOM_LEVELS].reverse().find((z) => z < s.zoom) ?? s.zoom);
      else if (key === "escape") s.setSelection(null);
      else if (key === "delete" || key === "backspace") s.clearPixels();
      else if (key === "enter") s.togglePlaying();
      else if (key === "," || key === ".") {
        const i = s.doc.frames.findIndex((f) => f.id === s.frameId);
        const next = s.doc.frames[(i + (key === "," ? -1 : 1) + s.doc.frames.length) % s.doc.frames.length];
        s.selectFrame(next.id);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function PixelView() {
  const loaded = usePixel((s) => s.loaded);
  const load = usePixel((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  useShortcuts();

  if (!loaded) return <div className="h-full bg-surround" />;

  return (
    <div className="flex h-full">
      <AiPanel />
      <section className="flex min-w-0 flex-1 flex-col bg-surround" aria-label="Sprite">
        <DocBar />
        <div className="flex min-h-0 flex-1">
          <ToolRail />
          <PixelCanvas />
        </div>
        <Timeline />
      </section>
      <aside className="flex w-[248px] shrink-0 flex-col border-l border-line bg-panel" aria-label="Palette and layers">
        <PalettePanel />
        <LayersPanel />
      </aside>
    </div>
  );
}
