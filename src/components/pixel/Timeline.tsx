"use client";

import { ChevronLeft, ChevronRight, Copy, Ghost, Pause, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";

import { MAX_FRAMES, composite } from "@/pixel/doc";
import { usePixel } from "@/pixel/store";

import { IconButton, cx } from "../ui";
import { PixelThumb } from "./PixelThumb";

function Status() {
  const hover = usePixel((s) => s.hover);
  const selection = usePixel((s) => s.selection);
  return (
    <div className="flex shrink-0 items-center gap-4 text-[13px] text-fg-faint">
      {selection && (
        <span title="Selection">
          {selection.w} × {selection.h} at {selection.x}, {selection.y}
        </span>
      )}
      <span className="w-16 text-right text-fg-dim" aria-live="off">
        {hover ? `${hover.x}, ${hover.y}` : ""}
      </span>
    </div>
  );
}

export function Timeline() {
  const doc = usePixel((s) => s.doc);
  const frameId = usePixel((s) => s.frameId);
  const playing = usePixel((s) => s.playing);
  const onion = usePixel((s) => s.onion);
  const { selectFrame, addFrame, duplicateFrame, removeFrame, moveFrame, setFps, togglePlaying, toggleOnion } =
    usePixel.getState();

  const index = doc.frames.findIndex((f) => f.id === frameId);
  const thumbs = useMemo(() => doc.frames.map((f) => composite(doc, f.id)), [doc]);

  // Playback steps through frames at the sprite's speed.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const s = usePixel.getState();
      const i = s.doc.frames.findIndex((f) => f.id === s.frameId);
      s.selectFrame(s.doc.frames[(i + 1) % s.doc.frames.length].id);
    }, 1000 / doc.fps);
    return () => clearInterval(timer);
  }, [playing, doc.fps]);

  return (
    <footer aria-label="Frames" className="flex h-[88px] shrink-0 items-center gap-3 border-t border-line bg-panel px-3">
      <div className="flex shrink-0 flex-col gap-1.5">
        <div className="flex items-center gap-0.5">
          <IconButton label={playing ? "Pause (Enter)" : "Play (Enter)"} onClick={togglePlaying} disabled={doc.frames.length < 2} active={playing}>
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </IconButton>
          <IconButton label="Onion skin: show the frames before and after" onClick={toggleOnion} active={onion} disabled={doc.frames.length < 2}>
            <Ghost size={15} />
          </IconButton>
          <label className="ml-1 flex items-center gap-1.5 text-[13px] text-fg-dim">
            <input
              type="number"
              min={1}
              max={30}
              value={doc.fps}
              onChange={(e) => setFps(Number(e.target.value) || 1)}
              aria-label="Frames per second"
              className="h-7 w-12 rounded-[4px] bg-field px-1.5 text-fg focus:outline-none"
            />
            fps
          </label>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton label="New frame" onClick={addFrame} disabled={doc.frames.length >= MAX_FRAMES}>
            <Plus size={15} />
          </IconButton>
          <IconButton label="Duplicate frame" onClick={duplicateFrame} disabled={doc.frames.length >= MAX_FRAMES}>
            <Copy size={14} />
          </IconButton>
          <IconButton label="Move frame left" onClick={() => moveFrame(frameId, -1)} disabled={index <= 0}>
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton label="Move frame right" onClick={() => moveFrame(frameId, 1)} disabled={index >= doc.frames.length - 1}>
            <ChevronRight size={15} />
          </IconButton>
          <IconButton label="Delete frame" onClick={() => removeFrame(frameId)} disabled={doc.frames.length <= 1}>
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>

      <ol className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1" aria-label="Frames in order">
        {doc.frames.map((frame, i) => (
          <li key={frame.id} className="shrink-0">
            <button
              type="button"
              onClick={() => selectFrame(frame.id)}
              aria-current={frame.id === frameId}
              aria-label={`Frame ${i + 1}`}
              className={cx(
                "relative flex flex-col items-center gap-0.5 rounded-[3px] p-1 outline-offset-0",
                frame.id === frameId ? "bg-raised" : "hover:bg-field",
              )}
            >
              <PixelThumb pixels={thumbs[i]} width={doc.width} height={doc.height} className="size-11 rounded-[2px]" />
              <span className={cx("text-[11.5px] leading-none", frame.id === frameId ? "text-safelight" : "text-fg-faint")}>{i + 1}</span>
            </button>
          </li>
        ))}
      </ol>

      <Status />
    </footer>
  );
}
