/**
 * The pixel assistant's editing tools. Each validates its own input (inputs
 * stream in unvalidated), works on an immutable editor state, and returns the
 * new state plus the text the model reads. Rendering images and running the
 * image backend happen in agent.ts, which has the browser and the stores.
 */
import { z } from "zod";

import type { ChatToolSpec } from "../providers/chat.ts";
import { INVALID_JSON } from "../providers/openrouter-format.ts";

import { PALETTE_PRESETS, alpha, hexToPacked, keyColorFor, packedToHex, type Packed } from "./color.ts";
import * as D from "./doc.ts";
import { NO_MIRROR, clampRect, clearRect, drawLine, drawRect, floodFill, type Rect, type Target } from "./raster.ts";

export interface EditorState {
  doc: D.PixelDoc;
  layerId: string;
  frameId: string;
  selection: Rect | null;
}

export interface ToolOutput {
  /** What the model reads. */
  text: string;
  /** One line for the chat log. */
  summary: string;
  isError?: boolean;
  /** The editor after the tool, when it changed anything. */
  state?: EditorState;
  /** A new sprite replaced the old one (like opening a file). */
  replaced?: boolean;
  /** Render this frame (or one layer of it) as an image for the model. */
  view?: { frameId: string; layerId: string | null; scale: number; background: Packed };
}

export interface PixelTool {
  name: string;
  spec: ChatToolSpec;
  run: (input: unknown, state: EditorState) => ToolOutput;
}

/** Grid characters for palette entries 0-61, as read_pixels shows them. */
export const KEYS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Characters for colours outside the palette (or past entry 61). */
const EXTRA = "!$%&*+-/:;<=>?@^_~|";
/** Largest area read_pixels returns at once. */
export const MAX_READ = 4096;

const int = (min: number, max: number) => z.number().int().min(min).max(max);
/** Positions may start off the sprite; drawing is clipped to it. */
const coord = int(-D.MAX_SIDE, 2 * D.MAX_SIDE);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use "#rrggbb"');
const colour = z
  .union([z.string().regex(/^(#[0-9a-fA-F]{6}|transparent)$/, 'Use "#rrggbb" or "transparent"'), int(0, 255)])
  .describe('"#rrggbb", "transparent", or a palette index');

export const toolError = (name: string, text: string): ToolOutput => ({ text, summary: `${name}: ${text}`, isError: true });
const fail = toolError;

export function toolSpec(name: string, description: string, input: z.ZodObject): ChatToolSpec {
  const schema = z.toJSONSchema(input, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return { name, description, schema };
}

/** Validates a model-written tool input; the message explains what to fix. */
export function parseToolInput<S extends z.ZodObject>(input: S, raw: unknown): { data: z.infer<S> } | { error: string } {
  if (raw && typeof raw === "object" && INVALID_JSON in raw) return { error: "The arguments were not valid JSON. Send them again." };
  const parsed = input.safeParse(raw ?? {});
  return parsed.success ? { data: parsed.data } : { error: `Invalid input. ${z.prettifyError(parsed.error)}` };
}

function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  run: (input: z.infer<S>, state: EditorState) => ToolOutput,
): PixelTool {
  return {
    name,
    spec: toolSpec(name, description, input),
    run(raw, state) {
      const parsed = parseToolInput(input, raw);
      return "error" in parsed ? fail(name, parsed.error) : run(parsed.data, state);
    },
  };
}

// ---- helpers ----

function toPacked(c: string | number, doc: D.PixelDoc): Packed | null {
  if (typeof c === "number") return c < doc.palette.length ? hexToPacked(doc.palette[c]) : null;
  return c === "transparent" ? 0 : hexToPacked(c);
}

const badColour = (name: string, c: string | number, doc: D.PixelDoc) =>
  fail(name, `Palette index ${c} does not exist; the palette has ${doc.palette.length} colours (0 to ${doc.palette.length - 1}).`);

const layerIndex = (s: EditorState) => s.doc.layers.findIndex((l) => l.id === s.layerId);
const frameIndex = (s: EditorState) => s.doc.frames.findIndex((f) => f.id === s.frameId);
const layerName = (s: EditorState) => `layer ${layerIndex(s) + 1} "${s.doc.layers[layerIndex(s)].name}"`;
const where = (s: EditorState) => `${layerName(s)}, frame ${frameIndex(s) + 1}`;

const drawnPixels = (pixels: Uint32Array | undefined) => {
  let n = 0;
  if (pixels) for (const c of pixels) if (c) n++;
  return n;
};

/** A writable copy of the current cel. */
function canvas(s: EditorState): Target {
  return { width: s.doc.width, height: s.doc.height, pixels: D.celPixels(s.doc, s.layerId, s.frameId).slice(), clip: null, mirror: NO_MIRROR };
}

const withPixels = (s: EditorState, pixels: Uint32Array): EditorState => ({ ...s, doc: D.withCel(s.doc, s.layerId, s.frameId, pixels) });

const changed = (before: Uint32Array, after: Uint32Array) => {
  let n = 0;
  for (let i = 0; i < after.length; i++) if (before[i] !== after[i]) n++;
  return n;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function paletteText(doc: D.PixelDoc) {
  if (!doc.palette.length) return "The palette is empty.";
  return `Palette (index: colour; grid characters 0-9, then a-z for 10-35, then A-Z for 36-61): ${doc.palette
    .map((c, i) => `${i}: ${c}`)
    .join(", ")}.`;
}

export function describeSprite(s: EditorState): string {
  const { doc } = s;
  const layers = [...doc.layers]
    .map((l, i) => {
      const drawn = drawnPixels(doc.cels[D.celKey(l.id, s.frameId)]);
      const flags = [l.id === s.layerId ? "current" : "", l.visible ? "" : "hidden", l.opacity < 1 ? `${Math.round(l.opacity * 100)}% opacity` : ""]
        .filter(Boolean)
        .join(", ");
      return `${i + 1} "${l.name}"${flags ? ` (${flags})` : ""}, ${plural(drawn, "pixel")} in this frame`;
    })
    .join("; ");
  const sel = s.selection ? `${s.selection.w}×${s.selection.h} at x=${s.selection.x}, y=${s.selection.y}` : "none";
  return [
    `Sprite "${doc.name}", ${doc.width}×${doc.height} pixels.`,
    paletteText(doc),
    `Layers, bottom to top: ${layers}.`,
    `Frames: ${doc.frames.length} at ${doc.fps} fps; frame ${frameIndex(s) + 1} is current.`,
    `Selection: ${sel}.`,
  ].join("\n");
}

/** One line of context for each user message. */
export function editorSummary(s: EditorState): string {
  const sel = s.selection ? `, selection ${s.selection.w}×${s.selection.h} at x=${s.selection.x}, y=${s.selection.y}` : "";
  return `Sprite ${s.doc.width}×${s.doc.height} with ${plural(s.doc.palette.length, "palette colour")}; current: ${where(s)} (of ${plural(
    s.doc.layers.length,
    "layer",
  )} and ${plural(s.doc.frames.length, "frame")})${sel}.`;
}

// ---- tools ----

const getSprite = tool(
  "get_sprite",
  "Read the sprite's size, palette, layers, frames and selection.",
  z.object({}).strict(),
  (_, s) => ({ text: describeSprite(s), summary: "Read the sprite" }),
);

const viewSprite = tool(
  "view_sprite",
  "Look at a frame as an image, enlarged so each sprite pixel is a clear square. Use it to check your work.",
  z
    .object({
      frame: int(1, D.MAX_FRAMES).optional().describe("Frame number, from 1. Default: the current frame."),
      layer_only: z.boolean().optional().describe("Show only the current layer instead of all visible layers."),
    })
    .strict(),
  (input, s) => {
    const frame = s.doc.frames[(input.frame ?? frameIndex(s) + 1) - 1];
    if (!frame) return fail("view_sprite", `There is no frame ${input.frame}; the sprite has ${s.doc.frames.length}.`);
    const n = s.doc.frames.indexOf(frame) + 1;
    const scale = Math.max(1, Math.min(32, Math.floor(768 / Math.max(s.doc.width, s.doc.height))));
    const background = keyColorFor(s.doc.palette.map(hexToPacked));
    return {
      text: `Frame ${n}${input.layer_only ? `, ${layerName(s)} only` : ""}, enlarged ${scale}×. Transparent pixels are shown as solid ${packedToHex(
        background,
      )}, a colour that is not in the palette.`,
      summary: `Looked at frame ${n}`,
      view: { frameId: frame.id, layerId: input.layer_only ? s.layerId : null, scale, background },
    };
  },
);

const readPixels = tool(
  "read_pixels",
  `Read exact pixels as a character grid: palette colours by their grid character, "." for transparent. At most ${MAX_READ} pixels at once (e.g. 64×64).`,
  z
    .object({
      x: int(0, D.MAX_SIDE - 1).default(0),
      y: int(0, D.MAX_SIDE - 1).default(0),
      width: int(1, D.MAX_SIDE).optional().describe("Default: to the right edge."),
      height: int(1, D.MAX_SIDE).optional().describe("Default: to the bottom edge."),
      source: z.enum(["frame", "layer"]).default("frame").describe('"frame": all visible layers combined; "layer": the current layer only.'),
    })
    .strict(),
  (input, s) => {
    const { doc } = s;
    const r = clampRect({ x: input.x, y: input.y, w: input.width ?? doc.width - input.x, h: input.height ?? doc.height - input.y }, doc.width, doc.height);
    if (!r) return fail("read_pixels", `That area is outside the ${doc.width}×${doc.height} sprite.`);
    if (r.w * r.h > MAX_READ) return fail("read_pixels", `That is ${r.w * r.h} pixels; read at most ${MAX_READ} at once, e.g. 64×64.`);
    const pixels = input.source === "layer" ? D.celPixels(doc, s.layerId, s.frameId) : D.composite(doc, s.frameId);

    const chars = new Map<Packed, string>();
    doc.palette.forEach((c, i) => {
      const p = hexToPacked(c);
      if (i < KEYS.length && !chars.has(p)) chars.set(p, KEYS[i]);
    });
    const used = new Map<string, string>();
    let extra = 0;
    const rows: string[] = [];
    for (let y = r.y; y < r.y + r.h; y++) {
      let row = "";
      for (let x = r.x; x < r.x + r.w; x++) {
        const c = pixels[y * doc.width + x];
        if (alpha(c) === 0) {
          row += ".";
          continue;
        }
        let ch = chars.get(c);
        if (!ch) {
          if (extra >= EXTRA.length) return fail("read_pixels", "This area has too many colours outside the palette; read a smaller area.");
          ch = EXTRA[extra++];
          chars.set(c, ch);
        }
        if (!used.has(ch)) {
          const a = alpha(c);
          const inPalette = doc.palette.includes(packedToHex(c)) && a === 255;
          used.set(ch, `${ch} ${packedToHex(c)}${a < 255 ? ` at ${Math.round((a / 255) * 100)}% opacity` : ""}${inPalette ? "" : " (not in the palette)"}`);
        }
        row += ch;
      }
      rows.push(row);
    }
    const pad = String(r.y + r.h - 1).length;
    const xs = Array.from({ length: r.w }, (_, i) => r.x + i);
    const ruler = [
      `${" ".repeat(pad + 2)}${xs.map((x) => (x % 10 === 0 ? String(Math.floor(x / 10) % 10) : " ")).join("")}`,
      `${" ".repeat(pad + 2)}${xs.map((x) => String(x % 10)).join("")}`,
    ];
    const what = input.source === "layer" ? where(s) : `frame ${frameIndex(s) + 1}, all visible layers`;
    return {
      text: [
        `${what}: x ${r.x} to ${r.x + r.w - 1}, y ${r.y} to ${r.y + r.h - 1}. Each line starts with its y; the ruler gives x. "." is transparent.`,
        used.size ? `Colours: ${[...used.values()].join(", ")}.` : "The area is empty.",
        ...ruler,
        ...rows.map((row, i) => `${String(r.y + i).padStart(pad)}  ${row}`),
      ].join("\n"),
      summary: `Read ${r.w}×${r.h} pixels at ${r.x},${r.y}`,
    };
  },
);

const drawPixels = tool(
  "draw_pixels",
  'Draw on the current layer from rows of characters, one character per pixel, starting at (x, y). "." and " " leave a pixel unchanged. Characters 0-9, a-z, A-Z are palette entries (as read_pixels shows them); map any other character, or override these, in `colors`. Use {"x": "transparent"} style entries to erase.',
  z
    .object({
      x: coord.describe("Left edge of the first column."),
      y: coord.describe("Top edge of the first row."),
      rows: z.array(z.string().max(D.MAX_SIDE)).min(1).max(D.MAX_SIDE).describe("Top to bottom; all rows start at x."),
      colors: z.record(z.string().length(1), colour).optional().describe("Character to colour, for characters that are not palette characters."),
    })
    .strict(),
  (input, s) => {
    const { doc } = s;
    const map = new Map<string, Packed>();
    for (const [ch, c] of Object.entries(input.colors ?? {})) {
      if (ch === "." || ch === " ") return fail("draw_pixels", `"${ch}" always means "leave unchanged"; pick another character.`);
      const p = toPacked(c, doc);
      if (p === null) return badColour("draw_pixels", c, doc);
      map.set(ch, p);
    }
    const unknown = new Set<string>();
    for (const row of input.rows) {
      for (const ch of row) {
        if (ch === "." || ch === " " || map.has(ch)) continue;
        const i = KEYS.indexOf(ch);
        if (i >= 0 && i < doc.palette.length) map.set(ch, hexToPacked(doc.palette[i]));
        else unknown.add(ch);
      }
    }
    if (unknown.size) {
      return fail(
        "draw_pixels",
        `Unknown characters ${[...unknown].map((c) => JSON.stringify(c)).join(", ")}. Map them in colors; palette characters go up to ${
          doc.palette.length ? `"${KEYS[Math.min(doc.palette.length, KEYS.length) - 1]}"` : "nothing (the palette is empty)"
        }.`,
      );
    }
    const t = canvas(s);
    const before = t.pixels.slice();
    let clipped = 0;
    input.rows.forEach((row, dy) => {
      [...row].forEach((ch, dx) => {
        if (ch === "." || ch === " ") return;
        const x = input.x + dx;
        const y = input.y + dy;
        if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) clipped++;
        else t.pixels[y * doc.width + x] = map.get(ch)!;
      });
    });
    const n = changed(before, t.pixels);
    return {
      text: `Changed ${plural(n, "pixel")} on ${where(s)}.${clipped ? ` ${plural(clipped, "pixel")} fell outside the ${doc.width}×${doc.height} sprite and were skipped.` : ""}`,
      summary: `Drew ${plural(n, "pixel")}`,
      state: withPixels(s, t.pixels),
    };
  },
);

const drawLineTool = tool(
  "draw_line",
  "Draw a straight line on the current layer, both ends included.",
  z.object({ x0: coord, y0: coord, x1: coord, y1: coord, color: colour, width: int(1, 8).default(1).describe("Square brush size.") }).strict(),
  (input, s) => {
    const c = toPacked(input.color, s.doc);
    if (c === null) return badColour("draw_line", input.color, s.doc);
    const t = canvas(s);
    const before = t.pixels.slice();
    drawLine(t, input.x0, input.y0, input.x1, input.y1, input.width, c);
    const n = changed(before, t.pixels);
    return { text: `Changed ${plural(n, "pixel")} on ${where(s)}.`, summary: `Drew a line (${plural(n, "pixel")})`, state: withPixels(s, t.pixels) };
  },
);

const drawRectTool = tool(
  "draw_rect",
  "Draw a rectangle on the current layer: an outline, or filled.",
  z
    .object({
      x: coord,
      y: coord,
      width: int(1, D.MAX_SIDE),
      height: int(1, D.MAX_SIDE),
      color: colour,
      filled: z.boolean().default(false),
      thickness: int(1, 16).default(1).describe("Outline thickness, growing inwards."),
    })
    .strict(),
  (input, s) => {
    const c = toPacked(input.color, s.doc);
    if (c === null) return badColour("draw_rect", input.color, s.doc);
    const t = canvas(s);
    const before = t.pixels.slice();
    drawRect(t, { x: input.x, y: input.y, w: input.width, h: input.height }, c, input.filled, input.thickness);
    const n = changed(before, t.pixels);
    return {
      text: `Changed ${plural(n, "pixel")} on ${where(s)}.`,
      summary: `Drew a ${input.filled ? "filled " : ""}rectangle (${plural(n, "pixel")})`,
      state: withPixels(s, t.pixels),
    };
  },
);

const fillTool = tool(
  "fill",
  'Fill on the current layer from (x, y): "area" fills the connected area of that pixel\'s colour (4-connected, like a paint bucket); "all" recolours every pixel of that colour on the layer.',
  z.object({ x: int(0, D.MAX_SIDE - 1), y: int(0, D.MAX_SIDE - 1), color: colour, mode: z.enum(["area", "all"]).default("area") }).strict(),
  (input, s) => {
    const { doc } = s;
    if (input.x >= doc.width || input.y >= doc.height) return fail("fill", `(${input.x}, ${input.y}) is outside the ${doc.width}×${doc.height} sprite.`);
    const c = toPacked(input.color, doc);
    if (c === null) return badColour("fill", input.color, doc);
    const t = canvas(s);
    const before = t.pixels.slice();
    if (input.mode === "area") floodFill(t, input.x, input.y, c);
    else {
      const from = t.pixels[input.y * doc.width + input.x];
      for (let i = 0; i < t.pixels.length; i++) if (t.pixels[i] === from) t.pixels[i] = c;
    }
    const n = changed(before, t.pixels);
    return { text: `Changed ${plural(n, "pixel")} on ${where(s)}.`, summary: `Filled ${plural(n, "pixel")}`, state: withPixels(s, t.pixels) };
  },
);

const clearTool = tool(
  "clear",
  "Erase an area of the current layer, or the whole layer when no area is given.",
  z.object({ x: coord.optional(), y: coord.optional(), width: int(1, D.MAX_SIDE).optional(), height: int(1, D.MAX_SIDE).optional() }).strict(),
  (input, s) => {
    const { doc } = s;
    const x = input.x ?? 0;
    const y = input.y ?? 0;
    const r = clampRect({ x, y, w: input.width ?? doc.width - x, h: input.height ?? doc.height - y }, doc.width, doc.height);
    if (!r) return fail("clear", "That area is outside the sprite.");
    const t = canvas(s);
    const before = t.pixels.slice();
    clearRect(t.pixels, doc.width, r);
    const n = changed(before, t.pixels);
    return { text: `Erased ${plural(n, "pixel")} on ${where(s)}.`, summary: `Erased ${plural(n, "pixel")}`, state: withPixels(s, t.pixels) };
  },
);

const presetIds = PALETTE_PRESETS.map((p) => p.id) as [string, ...string[]];

const setPalette = tool(
  "set_palette",
  `Change the palette: add colours, replace it, or load a preset (${PALETTE_PRESETS.map((p) => `${p.id}: ${p.name}`).join(", ")}). Pixels already drawn keep their colours.`,
  z
    .object({
      colors: z.array(hex).max(256).optional(),
      preset: z.enum(presetIds).optional(),
      mode: z.enum(["add", "replace"]).default("add"),
    })
    .strict(),
  (input, s) => {
    const preset = PALETTE_PRESETS.find((p) => p.id === input.preset);
    const colours = [...(preset?.colors ?? []), ...(input.colors ?? [])].map((c) => c.toLowerCase());
    if (!colours.length) return fail("set_palette", "Give colors or a preset.");
    const palette = [...new Set(input.mode === "replace" ? colours : [...s.doc.palette, ...colours])].slice(0, 256);
    const state = { ...s, doc: { ...s.doc, palette } };
    return { text: paletteText(state.doc), summary: `${input.mode === "replace" ? "Set" : "Extended"} the palette (${plural(palette.length, "colour")})`, state };
  },
);

const layersTool = tool(
  "layers",
  'Manage layers. Layers are numbered from 1 at the bottom. "add" puts a new layer above the current one and makes it current; most other actions use the current layer unless `layer` is given.',
  z
    .object({
      action: z.enum(["add", "duplicate", "select", "rename", "show", "hide", "set_opacity", "move_up", "move_down", "merge_down", "delete"]),
      layer: int(1, D.MAX_LAYERS).optional(),
      name: z.string().min(1).max(40).optional(),
      opacity: z.number().min(0).max(1).optional(),
    })
    .strict(),
  (input, s) => {
    const { doc } = s;
    const index = input.layer !== undefined ? input.layer - 1 : layerIndex(s);
    const layer = doc.layers[index];
    if (!layer) return fail("layers", `There is no layer ${input.layer}; the sprite has ${doc.layers.length}.`);
    let next: EditorState = s;
    switch (input.action) {
      case "add": {
        if (doc.layers.length >= D.MAX_LAYERS) return fail("layers", `A sprite can have at most ${D.MAX_LAYERS} layers.`);
        const added = D.addLayer(doc, index, input.name);
        next = { ...s, doc: added.doc, layerId: added.id };
        break;
      }
      case "duplicate": {
        if (doc.layers.length >= D.MAX_LAYERS) return fail("layers", `A sprite can have at most ${D.MAX_LAYERS} layers.`);
        const copy = D.duplicateLayer(doc, layer.id);
        next = { ...s, doc: input.name ? D.updateLayer(copy.doc, copy.id, { name: input.name }) : copy.doc, layerId: copy.id };
        break;
      }
      case "select":
        next = { ...s, layerId: layer.id };
        break;
      case "rename":
        if (!input.name) return fail("layers", "Give the new name.");
        next = { ...s, doc: D.updateLayer(doc, layer.id, { name: input.name }) };
        break;
      case "show":
      case "hide":
        next = { ...s, doc: D.updateLayer(doc, layer.id, { visible: input.action === "show" }) };
        break;
      case "set_opacity":
        if (input.opacity === undefined) return fail("layers", "Give the opacity, 0 to 1.");
        next = { ...s, doc: D.updateLayer(doc, layer.id, { opacity: input.opacity }) };
        break;
      case "move_up":
      case "move_down":
        next = { ...s, doc: D.moveLayer(doc, layer.id, input.action === "move_up" ? 1 : -1) };
        break;
      case "merge_down":
        if (index === 0) return fail("layers", "The bottom layer has nothing below it to merge into.");
        next = { ...s, doc: D.mergeDown(doc, layer.id), layerId: doc.layers[index - 1].id };
        break;
      case "delete": {
        if (doc.layers.length <= 1) return fail("layers", "The last layer cannot be deleted; clear it instead.");
        const fallback = doc.layers[index === 0 ? 1 : index - 1].id;
        next = { ...s, doc: D.removeLayer(doc, layer.id), layerId: layer.id === s.layerId ? fallback : s.layerId };
        break;
      }
    }
    const list = next.doc.layers.map((l, i) => `${i + 1} "${l.name}"${l.id === next.layerId ? " (current)" : ""}${l.visible ? "" : " (hidden)"}`);
    const current = next.doc.layers.find((l) => l.id === next.layerId)?.name ?? layer.name;
    return { text: `Layers, bottom to top: ${list.join(", ")}.`, summary: layerSummary(input.action, layer.name, input.name ?? current), state: next };
  },
);

function layerSummary(action: string, name: string, newName: string) {
  const labels: Record<string, string> = {
    add: `Added layer "${newName}"`,
    duplicate: `Duplicated layer "${name}"`,
    select: `Switched to layer "${name}"`,
    rename: `Renamed layer "${name}" to "${newName}"`,
    show: `Showed layer "${name}"`,
    hide: `Hid layer "${name}"`,
    set_opacity: `Changed the opacity of "${name}"`,
    move_up: `Moved layer "${name}" up`,
    move_down: `Moved layer "${name}" down`,
    merge_down: `Merged layer "${name}" down`,
    delete: `Deleted layer "${name}"`,
  };
  return labels[action] ?? "Changed layers";
}

const framesTool = tool(
  "frames",
  'Manage animation frames, numbered from 1. "add" inserts a blank frame after the current one; "duplicate" copies a frame (all layers) after it. Both make the new frame current. Other actions use the current frame unless `frame` is given.',
  z
    .object({
      action: z.enum(["add", "duplicate", "select", "delete", "move_earlier", "move_later", "set_fps"]),
      frame: int(1, D.MAX_FRAMES).optional(),
      fps: int(1, 30).optional(),
    })
    .strict(),
  (input, s) => {
    const { doc } = s;
    const index = input.frame !== undefined ? input.frame - 1 : frameIndex(s);
    const frame = doc.frames[index];
    if (!frame) return fail("frames", `There is no frame ${input.frame}; the sprite has ${doc.frames.length}.`);
    let next: EditorState = s;
    let summary = "";
    switch (input.action) {
      case "add":
      case "duplicate": {
        if (doc.frames.length >= D.MAX_FRAMES) return fail("frames", `A sprite can have at most ${D.MAX_FRAMES} frames.`);
        const added = input.action === "add" ? D.addFrame(doc, index) : D.duplicateFrame(doc, frame.id);
        next = { ...s, doc: added.doc, frameId: added.id };
        summary = input.action === "add" ? `Added frame ${index + 2}` : `Copied frame ${index + 1} to frame ${index + 2}`;
        break;
      }
      case "select":
        next = { ...s, frameId: frame.id };
        summary = `Switched to frame ${index + 1}`;
        break;
      case "delete":
        if (doc.frames.length <= 1) return fail("frames", "The last frame cannot be deleted.");
        next = { ...s, doc: D.removeFrame(doc, frame.id), frameId: frame.id === s.frameId ? doc.frames[index === 0 ? 1 : index - 1].id : s.frameId };
        summary = `Deleted frame ${index + 1}`;
        break;
      case "move_earlier":
      case "move_later":
        next = { ...s, doc: D.moveFrame(doc, frame.id, input.action === "move_later" ? 1 : -1) };
        summary = `Moved frame ${index + 1}`;
        break;
      case "set_fps":
        if (!input.fps) return fail("frames", "Give fps, 1 to 30.");
        next = { ...s, doc: { ...doc, fps: input.fps } };
        summary = `Set playback to ${input.fps} fps`;
        break;
    }
    return {
      text: `${plural(next.doc.frames.length, "frame")} at ${next.doc.fps} fps; frame ${frameIndex(next) + 1} is current.`,
      summary,
      state: next,
    };
  },
);

const newSprite = tool(
  "new_sprite",
  "Start a new sprite, replacing the current one (the user can undo it). Only when the user asks for a new sprite or a different size.",
  z
    .object({
      width: int(1, D.MAX_SIDE),
      height: int(1, D.MAX_SIDE),
      preset: z.enum(presetIds).optional().describe("Palette preset; default: keep the current palette."),
      colors: z.array(hex).max(256).optional().describe("Palette colours instead of a preset."),
      name: z.string().min(1).max(60).optional(),
    })
    .strict(),
  (input, s) => {
    const palette = input.colors ?? PALETTE_PRESETS.find((p) => p.id === input.preset)?.colors ?? s.doc.palette;
    const doc = D.createDoc({ width: input.width, height: input.height, palette, name: input.name ?? s.doc.name });
    const state: EditorState = { doc, layerId: doc.layers[0].id, frameId: doc.frames[0].id, selection: null };
    return { text: `New ${doc.width}×${doc.height} sprite.\n${paletteText(doc)}`, summary: `Started a new ${doc.width}×${doc.height} sprite`, state, replaced: true };
  },
);

export const EDIT_TOOLS: PixelTool[] = [
  getSprite,
  viewSprite,
  readPixels,
  drawPixels,
  drawLineTool,
  drawRectTool,
  fillTool,
  clearTool,
  setPalette,
  layersTool,
  framesTool,
  newSprite,
];
