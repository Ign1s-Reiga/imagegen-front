/**
 * Turns a generated image into real pixel art: one colour per sprite pixel,
 * taken from a palette. Models draw "pixel art" with soft, uneven fake
 * pixels, so each cell votes with the pixels near its centre, which skips the
 * blurred edges between fake pixels.
 */
import { PaletteMatcher, kmeansPalette, pack, type Packed } from "./color.ts";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface SnapOptions {
  width: number;
  height: number;
  /** Colours to use. Null: pick `colors` new ones from the image. */
  palette: Packed[] | null;
  colors?: number;
  /** Make the background reaching the edges transparent. */
  removeBackground?: boolean;
  /** A stand-in colour for transparency (see keyColorFor); cells matching it become transparent. */
  keyColor?: Packed | null;
}

export interface SnapResult {
  pixels: Uint32Array;
  /** The colours the result uses, in palette order. */
  palette: Packed[];
}

/** Share of a cell, on each side, left out when sampling. */
const EDGE = 0.2;

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The centred part of the image with the target's aspect ratio. */
export function cropToAspect(image: RgbaImage, width: number, height: number): Region {
  const target = width / height;
  const source = image.width / image.height;
  if (Math.abs(source - target) < 1e-6) return { x: 0, y: 0, w: image.width, h: image.height };
  if (source > target) {
    const w = image.height * target;
    return { x: (image.width - w) / 2, y: 0, w, h: image.height };
  }
  const h = image.width / target;
  return { x: 0, y: (image.height - h) / 2, w: image.width, h };
}

/** Calls `visit(offset)` for the sampled source pixels of one cell. */
function forCellSamples(image: RgbaImage, region: Region, cols: number, rows: number, cx: number, cy: number, visit: (offset: number) => void) {
  const cellW = region.w / cols;
  const cellH = region.h / rows;
  const left = region.x + cx * cellW;
  const top = region.y + cy * cellH;
  let x0 = Math.floor(left + cellW * EDGE);
  let x1 = Math.ceil(left + cellW * (1 - EDGE));
  let y0 = Math.floor(top + cellH * EDGE);
  let y1 = Math.ceil(top + cellH * (1 - EDGE));
  if (x1 <= x0) x1 = x0 + 1;
  if (y1 <= y0) y1 = y0 + 1;
  x0 = Math.max(0, Math.min(image.width - 1, x0));
  y0 = Math.max(0, Math.min(image.height - 1, y0));
  x1 = Math.max(x0 + 1, Math.min(image.width, x1));
  y1 = Math.max(y0 + 1, Math.min(image.height, y1));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) visit((y * image.width + x) * 4);
}

/** Average opaque colour of each cell, for choosing a new palette. */
function cellAverages(image: RgbaImage, region: Region, cols: number, rows: number) {
  const counts = new Map<Packed, number>();
  const { data } = image;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      let clear = 0;
      forCellSamples(image, region, cols, rows, cx, cy, (o) => {
        if (data[o + 3] < 128) {
          clear++;
          return;
        }
        r += data[o];
        g += data[o + 1];
        b += data[o + 2];
        n++;
      });
      if (n === 0 || clear > n) continue;
      const c = pack(Math.round(r / n), Math.round(g / n), Math.round(b / n));
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return counts;
}

export function snapToGrid(image: RgbaImage, options: SnapOptions): SnapResult {
  const { width: cols, height: rows } = options;
  const region = cropToAspect(image, cols, rows);

  let palette = options.palette;
  if (!palette?.length) {
    const counts = cellAverages(image, region, cols, rows);
    palette = kmeansPalette([...counts.keys()], [...counts.values()], options.colors ?? 16);
    if (!palette.length) return { pixels: new Uint32Array(cols * rows), palette: [] };
  }
  const key = options.keyColor ?? null;
  const matchable = key === null ? palette : [...palette, key];
  const keyIndex = key === null ? -1 : palette.length;
  const matcher = new PaletteMatcher(matchable);

  // -1 marks a transparent cell.
  const indices = new Int32Array(cols * rows);
  const votes = new Int32Array(matchable.length);
  const { data } = image;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      votes.fill(0);
      let clear = 0;
      forCellSamples(image, region, cols, rows, cx, cy, (o) => {
        if (data[o + 3] < 128) clear++;
        else votes[matcher.nearest(data[o], data[o + 1], data[o + 2])]++;
      });
      let best = 0;
      for (let i = 1; i < votes.length; i++) if (votes[i] > votes[best]) best = i;
      indices[cy * cols + cx] = clear > votes[best] || best === keyIndex ? -1 : best;
    }
  }

  if (options.removeBackground) clearEdgeBackground(indices, cols, rows);

  const pixels = new Uint32Array(cols * rows);
  const used = new Set<number>();
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    if (index < 0) continue;
    pixels[i] = (palette[index] | 0xff000000) >>> 0;
    used.add(index);
  }
  return { pixels, palette: palette.filter((_, i) => used.has(i)) };
}

/** Whether most pixels along a sprite's edges are transparent (a sprite rather than a scene). */
export function edgesMostlyClear(pixels: Uint32Array, width: number, height: number): boolean {
  let clear = 0;
  let total = 0;
  const visit = (i: number) => {
    total++;
    if (pixels[i] >>> 24 === 0) clear++;
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    if (height > 1) visit((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(y * width);
    if (width > 1) visit(y * width + width - 1);
  }
  return clear > total / 2;
}

/**
 * Finds the colour most common along the edges and clears every cell of it
 * that connects to an edge. Skipped when no single colour dominates the edges.
 */
export function clearEdgeBackground(indices: Int32Array, cols: number, rows: number) {
  const border: number[] = [];
  for (let x = 0; x < cols; x++) border.push(x, (rows - 1) * cols + x);
  for (let y = 1; y < rows - 1; y++) border.push(y * cols, y * cols + cols - 1);
  const counts = new Map<number, number>();
  for (const i of border) if (indices[i] >= 0) counts.set(indices[i], (counts.get(indices[i]) ?? 0) + 1);
  let background = -1;
  let most = 0;
  for (const [index, count] of counts) {
    if (count > most) {
      most = count;
      background = index;
    }
  }
  if (background < 0 || most < border.length * 0.3) return;
  const stack = border.filter((i) => indices[i] === background);
  while (stack.length) {
    const i = stack.pop()!;
    if (indices[i] !== background) continue;
    indices[i] = -1;
    const x = i % cols;
    if (x > 0) stack.push(i - 1);
    if (x < cols - 1) stack.push(i + 1);
    if (i >= cols) stack.push(i - cols);
    if (i < (rows - 1) * cols) stack.push(i + cols);
  }
}
