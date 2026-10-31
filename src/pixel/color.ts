/**
 * Pixel colours are packed the way a Uint32Array view of ImageData reads
 * them on little-endian machines: 0xAABBGGRR. 0 is fully transparent.
 *
 * Relative imports in src/pixel use explicit .ts extensions so the unit tests
 * can load these modules with Node directly.
 */
export type Packed = number;

export const TRANSPARENT: Packed = 0;

export const pack = (r: number, g: number, b: number, a = 255): Packed => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

export const red = (c: Packed) => c & 0xff;
export const green = (c: Packed) => (c >>> 8) & 0xff;
export const blue = (c: Packed) => (c >>> 16) & 0xff;
export const alpha = (c: Packed) => c >>> 24;

/** "#rrggbb" or "#rrggbbaa" to a packed colour; anything else is transparent. */
export function hexToPacked(hex: string): Packed {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return TRANSPARENT;
  const v = parseInt(m[1], 16);
  return pack((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff, m[2] ? parseInt(m[2], 16) : 255);
}

/** Packed colour to "#rrggbb" (alpha is dropped). */
export function packedToHex(c: Packed): string {
  const v = (red(c) << 16) | (green(c) << 8) | blue(c);
  return `#${v.toString(16).padStart(6, "0")}`;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const toGamma = (v: number) => {
  const x = Math.max(0, v);
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/** sRGB (0..255) to OKLab, where plain distances match perceived differences well. */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const labOf = (c: Packed) => rgbToOklab(red(c), green(c), blue(c));

const distance2 = (p: ArrayLike<number>, q: ArrayLike<number>) =>
  (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/** Finds the nearest palette entry for a colour, caching by 6 bits per channel. */
export class PaletteMatcher {
  private readonly labs: [number, number, number][];
  private readonly cache = new Int16Array(1 << 18).fill(-1);

  // No parameter properties here: Node's type stripping (used by the tests) rejects them.
  constructor(palette: Packed[]) {
    if (!palette.length) throw new Error("The palette is empty.");
    this.labs = palette.map(labOf);
  }

  nearest(r: number, g: number, b: number): number {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const hit = this.cache[key];
    if (hit >= 0) return hit;
    const lab = rgbToOklab(r, g, b);
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < this.labs.length; i++) {
      const d = distance2(lab, this.labs[i]);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    this.cache[key] = best;
    return best;
  }
}

/**
 * Reduces weighted colours to at most `k` representative ones with k-means in
 * OKLab. Deterministic: starts from the most common colour, then repeatedly
 * the colour farthest from those already chosen. Sorted dark to light.
 */
export function kmeansPalette(colors: Packed[], weights: number[], k: number, iterations = 16): Packed[] {
  const points = colors.map(labOf);
  if (!points.length || k <= 0) return [];
  if (points.length <= k) return sortByLightness([...colors]);

  let first = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i] > weights[first]) first = i;
  const centers: number[][] = [[...points[first]]];
  const nearestDistance = points.map((p) => distance2(p, centers[0]));
  while (centers.length < k) {
    let far = 0;
    for (let i = 1; i < points.length; i++) if (nearestDistance[i] > nearestDistance[far]) far = i;
    if (nearestDistance[far] === 0) break;
    centers.push([...points[far]]);
    for (let i = 0; i < points.length; i++) {
      nearestDistance[i] = Math.min(nearestDistance[i], distance2(points[i], centers[centers.length - 1]));
    }
  }

  const assignment = new Int32Array(points.length);
  for (let round = 0; round < iterations; round++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = distance2(points[i], centers[c]);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (assignment[i] !== best || round === 0) moved = true;
      assignment[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const sum = sums[assignment[i]];
      const w = weights[i];
      sum[0] += points[i][0] * w;
      sum[1] += points[i][1] * w;
      sum[2] += points[i][2] * w;
      sum[3] += w;
    }
    sums.forEach((sum, c) => {
      if (sum[3] > 0) centers[c] = [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]];
    });
    if (!moved) break;
  }

  const result = new Set<Packed>();
  for (const [L, a, b] of centers) result.add(pack(...oklabToRgb(L, a, b)));
  return sortByLightness([...result]);
}

export function sortByLightness(colors: Packed[]): Packed[] {
  return colors
    .map((c) => ({ c, L: labOf(c)[0] }))
    .sort((p, q) => p.L - q.L)
    .map((p) => p.c);
}

/** Distinct opaque colours used across the given pixel arrays, at most `limit`. */
export function usedColors(layers: Iterable<Uint32Array>, limit = 256): Packed[] {
  const seen = new Set<Packed>();
  for (const pixels of layers) {
    for (const c of pixels) {
      if (alpha(c) === 0) continue;
      seen.add((c | 0xff000000) >>> 0);
      if (seen.size >= limit) return [...seen];
    }
  }
  return [...seen];
}

/**
 * A colour far from every palette entry, used to stand in for transparency
 * when a sprite is sent to a model (models only see opaque images).
 */
export function keyColorFor(palette: Packed[]): Packed {
  const candidates = ["#ff00ff", "#00ff00", "#00ffff", "#ff0000", "#0000ff", "#ffff00"].map(hexToPacked);
  const labs = palette.map(labOf);
  let best = candidates[0];
  let bestDistance = -1;
  for (const c of candidates) {
    const lab = labOf(c);
    const d = labs.length ? Math.min(...labs.map((p) => distance2(p, lab))) : Infinity;
    if (d > bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return best;
}

export interface PalettePreset {
  id: string;
  name: string;
  colors: string[];
}

export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: "sweetie-16",
    name: "Sweetie 16",
    colors: [
      "#1a1c2c", "#5d275d", "#b13e53", "#ef7d57", "#ffcd75", "#a7f070", "#38b764", "#257179",
      "#29366f", "#3b5dc9", "#41a6f6", "#73eff7", "#f4f4f4", "#94b0c2", "#566c86", "#333c57",
    ],
  },
  {
    id: "pico-8",
    name: "PICO-8",
    colors: [
      "#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
      "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa",
    ],
  },
  {
    id: "endesga-32",
    name: "Endesga 32",
    colors: [
      "#be4a2f", "#d77643", "#ead4aa", "#e4a672", "#b86f50", "#733e39", "#3e2731", "#a22633",
      "#e43b44", "#f77622", "#feae34", "#fee761", "#63c74d", "#3e8948", "#265c42", "#193c3e",
      "#124e89", "#0099db", "#2ce8f5", "#ffffff", "#c0cbdc", "#8b9bb4", "#5a6988", "#3a4466",
      "#262b44", "#181425", "#ff0044", "#68386c", "#b55088", "#f6757a", "#e8b796", "#c28569",
    ],
  },
  { id: "four-greens", name: "Four greens", colors: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] },
  { id: "one-bit", name: "1-bit", colors: ["#000000", "#ffffff"] },
];

export const DEFAULT_PRESET = PALETTE_PRESETS[0];
