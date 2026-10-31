"use client";

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

import { TRANSPARENT, hexToPacked, packedToHex } from "@/pixel/color";
import { celPixels, composite, withCel, type PixelDoc } from "@/pixel/doc";
import { pixelsToImageData } from "@/pixel/image-io";
import {
  drawLine,
  drawRect,
  floodFill,
  inRect,
  moveRegion,
  rectFromCorners,
  stamp,
  type Rect,
  type Target,
} from "@/pixel/raster";
import { ZOOM_LEVELS, usePixel, type Tool } from "@/pixel/store";

type Stroke =
  | { kind: "paint"; buffer: Uint32Array; last: [number, number]; color: number }
  | { kind: "shape"; tool: "line" | "rect"; base: Uint32Array; buffer: Uint32Array; start: [number, number]; color: number }
  | { kind: "select"; start: [number, number]; end: [number, number] }
  | { kind: "move"; base: Uint32Array; buffer: Uint32Array; region: Rect; start: [number, number]; offset: [number, number]; hadSelection: boolean }
  | { kind: "pan"; startX: number; startY: number; pan: { x: number; y: number } };

const BACKDROP = "#202020";
const MARK = "rgba(118,118,118,0.85)";

function checkerPattern(ctx: CanvasRenderingContext2D) {
  const tile = document.createElement("canvas");
  tile.width = tile.height = 16;
  const t = tile.getContext("2d")!;
  t.fillStyle = "#2c2c2c";
  t.fillRect(0, 0, 16, 16);
  t.fillStyle = "#363636";
  t.fillRect(0, 0, 8, 8);
  t.fillRect(8, 8, 8, 8);
  return ctx.createPattern(tile, "repeat");
}

/** The sprite's top-left corner on screen, in CSS pixels. */
function originOf(doc: PixelDoc, zoom: number, pan: { x: number; y: number }, width: number, height: number) {
  return {
    x: Math.round(width / 2 - (doc.width * zoom) / 2 + pan.x),
    y: Math.round(height / 2 - (doc.height * zoom) / 2 + pan.y),
  };
}

const fitZoom = (doc: PixelDoc, width: number, height: number) => {
  const max = Math.min((width - 96) / doc.width, (height - 96) / doc.height);
  return [...ZOOM_LEVELS].reverse().find((z) => z <= max) ?? 1;
};

export function PixelCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<Stroke | null>(null);
  const spaceDown = useRef(false);
  const size = useRef({ width: 0, height: 0 });
  const frameRequest = useRef(0);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const pattern = useRef<CanvasPattern | null>(null);

  const tool = usePixel((s) => s.tool);
  const fitRequest = usePixel((s) => s.fitRequest);

  const draw = useCallback(() => {
    cancelAnimationFrame(frameRequest.current);
    frameRequest.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const s = usePixel.getState();
      const { doc, zoom, pan, layerId, frameId } = s;
      const { width, height } = size.current;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = BACKDROP;
      ctx.fillRect(0, 0, width, height);

      const o = originOf(doc, zoom, pan, width, height);
      const w = doc.width * zoom;
      const h = doc.height * zoom;

      pattern.current ??= checkerPattern(ctx);
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.fillStyle = pattern.current ?? "#2c2c2c";
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      scratch.current ??= document.createElement("canvas");
      const sc = scratch.current;
      if (sc.width !== doc.width || sc.height !== doc.height) {
        sc.width = doc.width;
        sc.height = doc.height;
      }
      const sctx = sc.getContext("2d")!;
      const blit = (pixels: Uint32Array, alpha = 1) => {
        sctx.putImageData(pixelsToImageData(pixels, doc.width, doc.height), 0, 0);
        ctx.globalAlpha = alpha;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sc, o.x, o.y, w, h);
        ctx.globalAlpha = 1;
      };

      if (s.onion && !s.playing && doc.frames.length > 1) {
        const index = doc.frames.findIndex((f) => f.id === frameId);
        const prev = doc.frames[index - 1];
        const next = doc.frames[index + 1];
        if (prev) blit(composite(doc, prev.id), 0.28);
        if (next) blit(composite(doc, next.id), 0.14);
      }

      const live = stroke.current;
      const override =
        live && (live.kind === "paint" || live.kind === "shape" || live.kind === "move")
          ? { layerId, pixels: live.buffer }
          : undefined;
      blit(composite(doc, frameId, override));

      if (s.showGrid && zoom >= 6) {
        ctx.lineWidth = 1 / dpr;
        for (const major of [false, true]) {
          ctx.strokeStyle = major ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.075)";
          ctx.beginPath();
          for (let x = 1; x < doc.width; x++) {
            if ((x % 8 === 0) !== major) continue;
            ctx.moveTo(o.x + x * zoom + 0.5 / dpr, o.y);
            ctx.lineTo(o.x + x * zoom + 0.5 / dpr, o.y + h);
          }
          for (let y = 1; y < doc.height; y++) {
            if ((y % 8 === 0) !== major) continue;
            ctx.moveTo(o.x, o.y + y * zoom + 0.5 / dpr);
            ctx.lineTo(o.x + w, o.y + y * zoom + 0.5 / dpr);
          }
          ctx.stroke();
        }
      }

      // Crop marks, as on the Generate stage.
      ctx.strokeStyle = MARK;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [
        [o.x, o.y, -1, -1],
        [o.x + w, o.y, 1, -1],
        [o.x, o.y + h, -1, 1],
        [o.x + w, o.y + h, 1, 1],
      ]) {
        ctx.moveTo(cx + dx * 6 + 0.5, cy + dy * 6 + 0.5);
        ctx.lineTo(cx + dx * 22 + 0.5, cy + dy * 6 + 0.5);
        ctx.moveTo(cx + dx * 6 + 0.5, cy + dy * 6 + 0.5);
        ctx.lineTo(cx + dx * 6 + 0.5, cy + dy * 22 + 0.5);
      }
      ctx.stroke();

      const selection =
        live?.kind === "select"
          ? rectFromCorners(live.start[0], live.start[1], live.end[0], live.end[1])
          : live?.kind === "move" && live.hadSelection
            ? { ...live.region, x: live.region.x + live.offset[0], y: live.region.y + live.offset[1] }
            : s.selection;
      if (selection) {
        const rx = o.x + selection.x * zoom + 0.5;
        const ry = o.y + selection.y * zoom + 0.5;
        const rw = selection.w * zoom - 1;
        const rh = selection.h * zoom - 1;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "#000";
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.lineDashOffset = 4;
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }

      const hover = s.hover;
      if (hover && !live && !spaceDown.current) {
        const brush = s.tool === "pencil" || s.tool === "eraser" || s.tool === "line" || s.tool === "rect" ? s.brushSize : 1;
        const start = -Math.floor((brush - 1) / 2);
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 1;
        ctx.strokeRect(o.x + (hover.x + start) * zoom + 0.5, o.y + (hover.y + start) * zoom + 0.5, brush * zoom - 1, brush * zoom - 1);
      }
    });
  }, []);

  // Redraw whenever anything the canvas shows changes.
  useEffect(
    () =>
      usePixel.subscribe((s, prev) => {
        if (
          s.doc !== prev.doc ||
          s.frameId !== prev.frameId ||
          s.layerId !== prev.layerId ||
          s.zoom !== prev.zoom ||
          s.pan !== prev.pan ||
          s.selection !== prev.selection ||
          s.showGrid !== prev.showGrid ||
          s.onion !== prev.onion ||
          s.playing !== prev.playing ||
          s.hover !== prev.hover ||
          s.tool !== prev.tool ||
          s.brushSize !== prev.brushSize
        ) {
          draw();
        }
      }),
    [draw],
  );

  const fitView = useCallback(() => {
    const { doc, setView } = usePixel.getState();
    const { width, height } = size.current;
    if (width && height) setView(fitZoom(doc, width, height), { x: 0, y: 0 });
  }, []);

  useEffect(() => {
    fitView();
  }, [fitRequest, fitView]);

  // Keep the canvas sized to its box, at device resolution.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      size.current = { width: wrap.clientWidth, height: wrap.clientHeight };
      canvas.width = Math.round(wrap.clientWidth * dpr);
      canvas.height = Math.round(wrap.clientHeight * dpr);
      if (first) {
        first = false;
        fitView();
      }
      draw();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [draw, fitView]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault();
      if (!spaceDown.current) {
        spaceDown.current = true;
        if (canvasRef.current) canvasRef.current.style.cursor = "grab";
        draw();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      spaceDown.current = false;
      if (canvasRef.current) canvasRef.current.style.cursor = "";
      draw();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [draw]);

  const pixelAt = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { doc, zoom, pan } = usePixel.getState();
    const o = originOf(doc, zoom, pan, size.current.width, size.current.height);
    return [Math.floor((e.clientX - rect.left - o.x) / zoom), Math.floor((e.clientY - rect.top - o.y) / zoom)];
  };

  const target = (pixels: Uint32Array): Target => {
    const s = usePixel.getState();
    return { width: s.doc.width, height: s.doc.height, pixels, clip: s.selection, mirror: s.mirror };
  };

  const pick = (x: number, y: number, secondary: boolean) => {
    const s = usePixel.getState();
    if (x < 0 || y < 0 || x >= s.doc.width || y >= s.doc.height) return;
    const c = composite(s.doc, s.frameId)[y * s.doc.width + x];
    if (c === TRANSPARENT) return;
    const hex = packedToHex(c);
    if (secondary) s.setSecondary(hex);
    else s.setPrimary(hex);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = usePixel.getState();
    if (stroke.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 1 || spaceDown.current) {
      stroke.current = { kind: "pan", startX: e.clientX, startY: e.clientY, pan: s.pan };
      e.currentTarget.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    if (s.playing) s.setPlaying(false);
    const secondary = e.button === 2;
    const [x, y] = pixelAt(e);
    const active: Tool = e.altKey ? "picker" : s.tool;
    const color = active === "eraser" ? TRANSPARENT : hexToPacked(secondary ? s.secondary : s.primary);
    const base = celPixels(s.doc, s.layerId, s.frameId);

    switch (active) {
      case "picker":
        pick(x, y, secondary);
        return;
      case "fill": {
        if (x < 0 || y < 0 || x >= s.doc.width || y >= s.doc.height) return;
        const buffer = base.slice();
        floodFill(target(buffer), x, y, color);
        s.commit(withCel(s.doc, s.layerId, s.frameId, buffer));
        return;
      }
      case "pencil":
      case "eraser": {
        const buffer = base.slice();
        stamp(target(buffer), x, y, s.brushSize, color);
        stroke.current = { kind: "paint", buffer, last: [x, y], color };
        break;
      }
      case "line":
      case "rect": {
        const buffer = base.slice();
        stroke.current = { kind: "shape", tool: active, base, buffer, start: [x, y], color };
        paintShape(stroke.current, x, y);
        break;
      }
      case "select":
        stroke.current = { kind: "select", start: clampPoint(s.doc, x, y), end: clampPoint(s.doc, x, y) };
        break;
      case "move": {
        const region = s.selection ?? { x: 0, y: 0, w: s.doc.width, h: s.doc.height };
        if (s.selection && !inRect(s.selection, x, y)) return;
        stroke.current = { kind: "move", base, buffer: base, region, start: [x, y], offset: [0, 0], hadSelection: !!s.selection };
        break;
      }
    }
    draw();
  };

  const paintShape = (st: Extract<Stroke, { kind: "shape" }>, x: number, y: number) => {
    const s = usePixel.getState();
    st.buffer = st.base.slice();
    const t = target(st.buffer);
    if (st.tool === "line") drawLine(t, st.start[0], st.start[1], x, y, s.brushSize, st.color);
    else drawRect(t, rectFromCorners(st.start[0], st.start[1], x, y), st.color, s.shapeFill, s.brushSize);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const s = usePixel.getState();
    const [x, y] = pixelAt(e);
    const inside = x >= 0 && y >= 0 && x < s.doc.width && y < s.doc.height;
    s.setHover(inside ? { x, y } : null);
    const st = stroke.current;
    if (!st) return;
    switch (st.kind) {
      case "pan":
        s.setView(s.zoom, { x: st.pan.x + e.clientX - st.startX, y: st.pan.y + e.clientY - st.startY });
        return;
      case "paint":
        if (st.last[0] === x && st.last[1] === y) return;
        drawLine(target(st.buffer), st.last[0], st.last[1], x, y, s.brushSize, st.color);
        st.last = [x, y];
        break;
      case "shape":
        paintShape(st, x, y);
        break;
      case "select":
        st.end = clampPoint(s.doc, x, y);
        break;
      case "move": {
        const dx = x - st.start[0];
        const dy = y - st.start[1];
        if (dx === st.offset[0] && dy === st.offset[1]) return;
        st.offset = [dx, dy];
        st.buffer = moveRegion(st.base, s.doc.width, s.doc.height, st.region, dx, dy);
        break;
      }
    }
    draw();
  };

  const finish = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const st = stroke.current;
    stroke.current = null;
    if (!st) return;
    const s = usePixel.getState();
    switch (st.kind) {
      case "pan":
        e.currentTarget.style.cursor = spaceDown.current ? "grab" : "";
        break;
      case "paint":
      case "shape":
        s.commit(withCel(s.doc, s.layerId, s.frameId, st.buffer));
        break;
      case "select": {
        const rect = rectFromCorners(st.start[0], st.start[1], st.end[0], st.end[1]);
        // A click without a drag clears the selection.
        s.setSelection(rect.w === 1 && rect.h === 1 && st.start[0] === st.end[0] ? null : rect);
        break;
      }
      case "move":
        if (st.offset[0] || st.offset[1]) {
          s.commit(withCel(s.doc, s.layerId, s.frameId, st.buffer));
          if (st.hadSelection) s.setSelection({ ...st.region, x: st.region.x + st.offset[0], y: st.region.y + st.offset[1] });
        }
        break;
    }
    draw();
  };

  const onWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    const s = usePixel.getState();
    const index = ZOOM_LEVELS.indexOf(s.zoom);
    const current = index >= 0 ? index : ZOOM_LEVELS.findIndex((z) => z >= s.zoom);
    const next = ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, current + (e.deltaY < 0 ? 1 : -1)))];
    if (next === s.zoom) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { width, height } = size.current;
    const o = originOf(s.doc, s.zoom, s.pan, width, height);
    // Keep the sprite pixel under the pointer in place.
    const fx = (mx - o.x) / s.zoom;
    const fy = (my - o.y) / s.zoom;
    s.setView(next, {
      x: mx - fx * next - width / 2 + (s.doc.width * next) / 2,
      y: my - fy * next - height / 2 + (s.doc.height * next) / 2,
    });
  };

  return (
    <div ref={wrapRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      <canvas
        ref={canvasRef}
        aria-label="Sprite canvas"
        className="absolute inset-0 size-full touch-none"
        style={{ cursor: cursorFor(tool) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onPointerLeave={() => usePixel.getState().setHover(null)}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={onWheel}
      />
    </div>
  );
}


const clampPoint = (doc: PixelDoc, x: number, y: number): [number, number] => [
  Math.max(0, Math.min(doc.width - 1, x)),
  Math.max(0, Math.min(doc.height - 1, y)),
];

function cursorFor(tool: Tool) {
  if (tool === "move") return "move";
  if (tool === "picker") return "copy";
  return "crosshair";
}

export function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
  );
}
