/** Drawing on a pixel array. All functions mutate `target.pixels` in place. */
import type { Packed } from "./color.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Mirror {
  x: boolean;
  y: boolean;
}

export interface Target {
  width: number;
  height: number;
  pixels: Uint32Array;
  /** Drawing outside this rectangle is ignored. */
  clip: Rect | null;
  mirror: Mirror;
}

export const NO_MIRROR: Mirror = { x: false, y: false };

export const inRect = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/** The rectangle spanned by two corner pixels, both included. */
export function rectFromCorners(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 };
}

export function clampRect(r: Rect, width: number, height: number): Rect | null {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const w = Math.min(width, r.x + r.w) - x;
  const h = Math.min(height, r.y + r.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function plot(t: Target, x: number, y: number, color: Packed) {
  if (x < 0 || y < 0 || x >= t.width || y >= t.height) return;
  if (t.clip && !inRect(t.clip, x, y)) return;
  t.pixels[y * t.width + x] = color;
}

/** Sets one pixel and its mirrored twins. */
export function setPixel(t: Target, x: number, y: number, color: Packed) {
  plot(t, x, y, color);
  const mx = t.width - 1 - x;
  const my = t.height - 1 - y;
  if (t.mirror.x) plot(t, mx, y, color);
  if (t.mirror.y) plot(t, x, my, color);
  if (t.mirror.x && t.mirror.y) plot(t, mx, my, color);
}

/** A square brush of `size` pixels; odd sizes centre on (x, y). */
export function stamp(t: Target, x: number, y: number, size: number, color: Packed) {
  const start = -Math.floor((size - 1) / 2);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) setPixel(t, x + start + dx, y + start + dy, color);
  }
}

/** Every pixel on the line between two points (Bresenham), both ends included. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const points: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    points.push([x, y]);
    if (x === x1 && y === y1) return points;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

export function drawLine(t: Target, x0: number, y0: number, x1: number, y1: number, size: number, color: Packed) {
  for (const [x, y] of linePoints(x0, y0, x1, y1)) stamp(t, x, y, size, color);
}

export function drawRect(t: Target, r: Rect, color: Packed, filled: boolean, size = 1) {
  if (filled) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setPixel(t, x, y, color);
    return;
  }
  const x1 = r.x + r.w - 1;
  const y1 = r.y + r.h - 1;
  // Thick outlines grow inwards so the rectangle keeps the size that was dragged.
  for (let i = 0; i < size; i++) {
    const inner = { x: r.x + i, y: r.y + i, w: r.w - 2 * i, h: r.h - 2 * i };
    if (inner.w <= 0 || inner.h <= 0) break;
    const ix1 = x1 - i;
    const iy1 = y1 - i;
    for (let x = inner.x; x <= ix1; x++) {
      setPixel(t, x, inner.y, color);
      setPixel(t, x, iy1, color);
    }
    for (let y = inner.y; y <= iy1; y++) {
      setPixel(t, inner.x, y, color);
      setPixel(t, ix1, y, color);
    }
  }
}

/** Fills the 4-connected area of the colour at (x, y). Mirrored twins fill too. */
export function floodFill(t: Target, x: number, y: number, color: Packed) {
  const seeds: [number, number][] = [[x, y]];
  if (t.mirror.x) seeds.push([t.width - 1 - x, y]);
  if (t.mirror.y) seeds.push([x, t.height - 1 - y]);
  if (t.mirror.x && t.mirror.y) seeds.push([t.width - 1 - x, t.height - 1 - y]);
  for (const [sx, sy] of seeds) fillFrom(t, sx, sy, color);
}

function fillFrom(t: Target, x: number, y: number, color: Packed) {
  const { width, height, pixels, clip } = t;
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  if (clip && !inRect(clip, x, y)) return;
  const target = pixels[y * width + x];
  if (target === color) return;
  const stack = [y * width + x];
  while (stack.length) {
    const i = stack.pop()!;
    if (pixels[i] !== target) continue;
    const px = i % width;
    const py = (i - px) / width;
    if (clip && !inRect(clip, px, py)) continue;
    pixels[i] = color;
    if (px > 0) stack.push(i - 1);
    if (px < width - 1) stack.push(i + 1);
    if (py > 0) stack.push(i - width);
    if (py < height - 1) stack.push(i + width);
  }
}

export function clearRect(pixels: Uint32Array, width: number, r: Rect) {
  for (let y = r.y; y < r.y + r.h; y++) pixels.fill(0, y * width + r.x, y * width + r.x + r.w);
}

/**
 * Moves the pixels inside `region` by (dx, dy). The region's old place is
 * cleared; pixels moved off the canvas are lost. Returns a new array.
 */
export function moveRegion(base: Uint32Array, width: number, height: number, region: Rect, dx: number, dy: number): Uint32Array {
  const out = base.slice();
  clearRect(out, width, region);
  for (let y = region.y; y < region.y + region.h; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= height) continue;
    for (let x = region.x; x < region.x + region.w; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= width) continue;
      const c = base[y * width + x];
      if (c) out[ty * width + tx] = c;
    }
  }
  return out;
}

/** Copies the pixels of `src` inside `region` onto `dst` (a new array). */
export function pasteRegion(dst: Uint32Array, src: Uint32Array, width: number, region: Rect): Uint32Array {
  const out = dst.slice();
  for (let y = region.y; y < region.y + region.h; y++) {
    const row = y * width;
    out.set(src.subarray(row + region.x, row + region.x + region.w), row + region.x);
  }
  return out;
}
