import assert from "node:assert/strict";
import { test } from "node:test";

import { INVALID_JSON } from "../providers/openrouter-format.ts";

import { EDIT_TOOLS, KEYS, describeSprite, type EditorState, type ToolOutput } from "./agent-tools.ts";
import { hexToPacked } from "./color.ts";
import * as D from "./doc.ts";

const PALETTE = ["#000000", "#ffffff", "#ff0000", "#00ff00"];

function fresh(width = 8, height = 8): EditorState {
  const doc = D.createDoc({ width, height, palette: PALETTE });
  return { doc, layerId: doc.layers[0].id, frameId: doc.frames[0].id, selection: null };
}

const run = (name: string, input: unknown, state: EditorState): ToolOutput => {
  const tool = EDIT_TOOLS.find((t) => t.name === name);
  assert.ok(tool, name);
  return tool.run(input, state);
};

/** Current layer as rows, one character per pixel ("." empty, else palette key). */
function rows(s: EditorState): string[] {
  const pixels = D.celPixels(s.doc, s.layerId, s.frameId);
  const out: string[] = [];
  for (let y = 0; y < s.doc.height; y++) {
    let row = "";
    for (let x = 0; x < s.doc.width; x++) {
      const c = pixels[y * s.doc.width + x];
      row += c ? KEYS[s.doc.palette.findIndex((p) => hexToPacked(p) === c)] ?? "?" : ".";
    }
    out.push(row);
  }
  return out;
}

test("tool schemas are plain JSON Schema objects", () => {
  const names = new Set<string>();
  for (const t of EDIT_TOOLS) {
    assert.equal(t.spec.schema.type, "object", t.name);
    assert.equal("$schema" in t.spec.schema, false, t.name);
    assert.match(t.name, /^[a-z_]+$/);
    names.add(t.name);
  }
  assert.equal(names.size, EDIT_TOOLS.length, "unique names");
});

test("draw_pixels uses palette characters, a colour map, and leaves '.' alone", () => {
  let s = fresh(6, 3);
  s = run("draw_pixels", { x: 0, y: 0, rows: ["111111"] }, s).state!;
  const out = run("draw_pixels", { x: 1, y: 0, rows: ["2.x", " 3", "33"], colors: { x: "transparent" } }, s);
  assert.ok(!out.isError, out.text);
  assert.deepEqual(rows(out.state!), ["121.11", "..3...", ".33..."]);
  assert.match(out.text, /Changed 5 pixels/);
});

test("draw_pixels clips at the edges and rejects unknown characters", () => {
  const out = run("draw_pixels", { x: 6, y: -1, rows: ["222", "222"] }, fresh(8, 2));
  assert.deepEqual(rows(out.state!), ["......22", "........"]);
  assert.match(out.text, /4 pixels fell outside/);
  const bad = run("draw_pixels", { x: 0, y: 0, rows: ["1z"] }, fresh());
  assert.equal(bad.isError, true);
  assert.match(bad.text, /"z"/);
  assert.equal(bad.state, undefined, "nothing drawn");
});

test("read_pixels returns a grid with a ruler and legend", () => {
  let s = fresh(4, 2);
  s = run("draw_pixels", { x: 0, y: 0, rows: ["2.", ".x"], colors: { x: "#123456" } }, s).state!;
  const out = run("read_pixels", {}, s);
  assert.ok(!out.isError, out.text);
  assert.match(out.text, /2 #ff0000/);
  assert.match(out.text, /! #123456 \(not in the palette\)/);
  assert.ok(out.text.includes("0  2..."), out.text);
  assert.ok(out.text.includes("1  .!.."), out.text);
  const big = run("read_pixels", {}, fresh(100, 100));
  assert.equal(big.isError, true);
});

test("fill: connected area or every pixel of a colour", () => {
  let s = fresh(5, 1);
  s = run("draw_pixels", { x: 0, y: 0, rows: ["11.11"] }, s).state!;
  assert.deepEqual(rows(run("fill", { x: 0, y: 0, color: 2 }, s).state!), ["22.11"]);
  assert.deepEqual(rows(run("fill", { x: 0, y: 0, color: "#00ff00", mode: "all" }, s).state!), ["33.33"]);
  assert.match(run("fill", { x: 0, y: 0, color: 9 }, s).text, /Palette index 9 does not exist/);
});

test("draw_line, draw_rect and clear", () => {
  let s = run("draw_rect", { x: 0, y: 0, width: 4, height: 3, color: 1 }, fresh(4, 3)).state!;
  assert.deepEqual(rows(s), ["1111", "1..1", "1111"]);
  s = run("draw_line", { x0: 0, y0: 1, x1: 3, y1: 1, color: 2 }, s).state!;
  assert.deepEqual(rows(s), ["1111", "2222", "1111"]);
  s = run("clear", { x: 1, y: 0, width: 2, height: 3 }, s).state!;
  assert.deepEqual(rows(s), ["1..1", "2..2", "1..1"]);
  assert.equal(D.celPixels(run("clear", {}, s).state!.doc, s.layerId, s.frameId).some((c) => c !== 0), false);
});

test("layers: add, select, merge and delete keep a valid current layer", () => {
  let s = run("draw_pixels", { x: 0, y: 0, rows: ["1"] }, fresh(2, 1)).state!;
  const added = run("layers", { action: "add", name: "Top" }, s);
  s = added.state!;
  assert.equal(s.doc.layers.length, 2);
  assert.equal(s.doc.layers[1].name, "Top");
  assert.equal(s.layerId, s.doc.layers[1].id, "new layer is current");
  assert.equal(added.summary, 'Added layer "Top"');
  s = run("draw_pixels", { x: 1, y: 0, rows: ["2"] }, s).state!;
  s = run("layers", { action: "merge_down" }, s).state!;
  assert.equal(s.doc.layers.length, 1);
  assert.deepEqual(rows(s), ["12"]);
  assert.equal(run("layers", { action: "delete" }, s).isError, true, "last layer stays");
  const two = run("layers", { action: "add" }, s).state!;
  const deleted = run("layers", { action: "delete", layer: 1 }, { ...two, layerId: two.doc.layers[0].id }).state!;
  assert.equal(deleted.doc.layers.length, 1);
  assert.equal(deleted.layerId, deleted.doc.layers[0].id);
  assert.equal(run("layers", { action: "select", layer: 5 }, s).isError, true);
});

test("frames: duplicate copies every layer and becomes current", () => {
  let s = run("draw_pixels", { x: 0, y: 0, rows: ["3"] }, fresh(1, 1)).state!;
  s = run("frames", { action: "duplicate" }, s).state!;
  assert.equal(s.doc.frames.length, 2);
  assert.equal(s.frameId, s.doc.frames[1].id);
  assert.deepEqual(rows(s), ["3"]);
  s = run("frames", { action: "set_fps", fps: 12 }, s).state!;
  assert.equal(s.doc.fps, 12);
  assert.equal(run("frames", { action: "delete", frame: 3 }, s).isError, true);
});

test("palette and new sprite", () => {
  const s = fresh();
  const added = run("set_palette", { colors: ["#ABCDEF", "#000000"] }, s).state!;
  assert.deepEqual(added.doc.palette, [...PALETTE, "#abcdef"]);
  const preset = run("set_palette", { preset: "pico-8", mode: "replace" }, s).state!;
  assert.equal(preset.doc.palette.length, 16);
  const next = run("new_sprite", { width: 16, height: 24 }, s);
  assert.equal(next.replaced, true);
  assert.equal(next.state!.doc.width, 16);
  assert.deepEqual(next.state!.doc.palette, PALETTE, "keeps the palette by default");
});

test("view_sprite asks for a render with a background outside the palette", () => {
  const out = run("view_sprite", {}, fresh(16, 16));
  assert.ok(out.view);
  assert.equal(out.view.scale, 32);
  assert.ok(!PALETTE.map(hexToPacked).includes(out.view.background));
  assert.equal(run("view_sprite", { frame: 2 }, fresh()).isError, true);
});

test("bad input is reported, not run", () => {
  const s = fresh();
  const out = run("draw_rect", { x: 0, y: 0, width: 0, height: 2, color: 1 }, s);
  assert.equal(out.isError, true);
  assert.match(out.text, /width/);
  assert.match(run("fill", { [INVALID_JSON]: "{x" }, s).text, /not valid JSON/);
  assert.equal(run("get_sprite", { extra: 1 }, s).isError, true);
  assert.match(describeSprite(s), /8×8 pixels/);
});
