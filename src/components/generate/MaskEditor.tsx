"use client";

import { FlipHorizontal2, Trash2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { maskFromAlpha, maskToAlpha } from "@/lib/mask";
import { useImageUrl } from "@/lib/use-image-url";
import type { InputImage } from "@/providers/types";

import { Button, IconButton, Segmented, useRestoreFocus } from "../ui";

/** Paint colour; the canvas is shown translucent over the image. */
const PAINT: [number, number, number] = [240, 165, 60];
const UNDO_LIMIT = 15;
const MIN_SIZE = 4;
const MAX_SIZE = 300;

type Point = { x: number; y: number };

export function MaskEditor({
  image,
  mask,
  onSave,
  onClose,
}: {
  image: InputImage;
  mask: InputImage | null;
  onSave: (mask: InputImage | null) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const undoStack = useRef<ImageData[]>([]);
  const last = useRef<Point | null>(null);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [size, setSize] = useState(48);
  const [display, setDisplay] = useState<{ width: number; height: number } | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [saving, setSaving] = useState(false);

  const imageUrl = useImageUrl(image.bytes, image.mime);

  const ctx = () => canvasRef.current?.getContext("2d", { willReadFrequently: true }) ?? null;

  // Fit the image into the stage, keeping its aspect ratio.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const maxW = stage.clientWidth - 64;
      const maxH = stage.clientHeight - 64;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1.5);
      setDisplay({ width: Math.round(image.width * scale), height: Math.round(image.height * scale) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [image.width, image.height]);

  // Start from the existing mask, if any (once the canvas is mounted).
  const mounted = display !== null;
  useEffect(() => {
    if (!mask || !mounted) return;
    let cancelled = false;
    void maskToAlpha(mask, image.width, image.height).then((alpha) => {
      const c = ctx();
      if (cancelled || !c) return;
      const data = new ImageData(image.width, image.height);
      for (let i = 0, j = 0; j < alpha.length; i += 4, j++) {
        data.data[i] = PAINT[0];
        data.data[i + 1] = PAINT[1];
        data.data[i + 2] = PAINT[2];
        data.data[i + 3] = alpha[j];
      }
      c.putImageData(data, 0, 0);
    });
    return () => {
      cancelled = true;
    };
  }, [mask, mounted, image.width, image.height]);

  useRestoreFocus();
  useEffect(() => dialogRef.current?.focus(), []);

  const snapshot = () => {
    const c = ctx();
    if (!c) return;
    undoStack.current.push(c.getImageData(0, 0, image.width, image.height));
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setCanUndo(true);
  };

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    const c = canvasRef.current?.getContext("2d");
    if (previous && c) c.putImageData(previous, 0, 0);
    setCanUndo(undoStack.current.length > 0);
  }, []);

  const clear = () => {
    snapshot();
    ctx()?.clearRect(0, 0, image.width, image.height);
  };

  const invert = () => {
    const c = ctx();
    if (!c) return;
    snapshot();
    const data = c.getImageData(0, 0, image.width, image.height);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i] = PAINT[0];
      data.data[i + 1] = PAINT[1];
      data.data[i + 2] = PAINT[2];
      data.data[i + 3] = 255 - data.data[i + 3];
    }
    c.putImageData(data, 0, 0);
  };

  const save = useCallback(async () => {
    const c = canvasRef.current?.getContext("2d", { willReadFrequently: true });
    if (!c) return;
    setSaving(true);
    try {
      onSave(await maskFromAlpha(c.getImageData(0, 0, image.width, image.height)));
      onClose();
    } finally {
      setSaving(false);
    }
  }, [image.width, image.height, onSave, onClose]);

  const toCanvas = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * image.width) / rect.width,
      y: ((e.clientY - rect.top) * image.height) / rect.height,
    };
  };

  const stroke = (from: Point, to: Point, canvas: HTMLCanvasElement) => {
    const c = ctx();
    if (!c) return;
    const scale = image.width / canvas.getBoundingClientRect().width;
    c.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    c.strokeStyle = `rgb(${PAINT.join(",")})`;
    c.lineWidth = size * scale;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.lineTo(to.x, to.y);
    c.stroke();
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    snapshot();
    const p = toCanvas(e);
    last.current = p;
    stroke(p, p, e.currentTarget);
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (!last.current) return;
    const p = toCanvas(e);
    stroke(last.current, p, e.currentTarget);
    last.current = p;
  };

  const endStroke = () => {
    last.current = null;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase: keep Ctrl+Enter from starting a generation behind the editor.
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void save();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if (e.key === "[") setSize((s) => Math.max(MIN_SIZE, Math.round(s / 1.2)));
      else if (e.key === "]") setSize((s) => Math.min(MAX_SIZE, Math.round(s * 1.2)));
      else if (e.key.toLowerCase() === "b") setTool("brush");
      else if (e.key.toLowerCase() === "e") setTool("eraser");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save, onClose, undo]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Paint the area to change"
      tabIndex={-1}
      className="fixed inset-0 z-40 flex flex-col bg-surround outline-none"
    >
      <div className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel px-4">
        <p className="text-[14px] text-fg">Paint over the area to change</p>
        <div className="w-44">
          <Segmented
            label="Tool"
            value={tool}
            onChange={setTool}
            options={[
              { value: "brush", label: "Brush" },
              { value: "eraser", label: "Eraser" },
            ]}
          />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-fg-dim">
          Size
          <input
            type="range"
            min={MIN_SIZE}
            max={MAX_SIZE}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-36"
          />
          <span className="w-8 text-fg">{size}</span>
        </label>
        <div className="flex items-center gap-0.5">
          <IconButton label="Undo (Ctrl Z)" onClick={undo} disabled={!canUndo}>
            <Undo2 size={15} />
          </IconButton>
          <IconButton label="Invert: change everything except what is painted" onClick={invert}>
            <FlipHorizontal2 size={15} />
          </IconButton>
          <IconButton label="Clear the mask" onClick={clear}>
            <Trash2 size={15} />
          </IconButton>
        </div>
        <p className="hidden text-[12.5px] text-fg-faint xl:block">
          B brush, E eraser, [ and ] size
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            Use this mask
          </Button>
        </div>
      </div>

      <div ref={stageRef} className="grid min-h-0 flex-1 place-items-center overflow-hidden">
        {display && (
          <div className="relative" style={{ width: display.width, height: display.height }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {imageUrl && <img src={imageUrl} alt="Input image" className="block size-full select-none" draggable={false} />}
            <canvas
              ref={canvasRef}
              width={image.width}
              height={image.height}
              aria-label="Mask painting area"
              className="absolute inset-0 size-full cursor-none touch-none opacity-55"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={() => setCursor(null)}
            />
            {cursor && (
              <span
                aria-hidden
                className="pointer-events-none absolute rounded-full border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{
                  width: size,
                  height: size,
                  left: cursor.x - size / 2,
                  top: cursor.y - size / 2,
                  borderStyle: tool === "eraser" ? "dashed" : "solid",
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
