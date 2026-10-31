import assert from "node:assert/strict";
import { test } from "node:test";

import { pack } from "./color.ts";
import {
  addFrame,
  addLayer,
  celKey,
  celPixels,
  composite,
  createDoc,
  duplicateFrame,
  duplicateLayer,
  fromFile,
  mergeDown,
  moveLayer,
  removeFrame,
  removeLayer,
  toFile,
  updateLayer,
  withCel,
} from "./doc.ts";

const RED = pack(255, 0, 0);
const BLUE = pack(0, 0, 255);

test("new documents have one layer, one frame, no pixels", () => {
  const doc = createDoc({ width: 400, height: 0 });
  assert.equal(doc.width, 256, "sides are clamped");
  assert.equal(doc.height, 1);
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.frames.length, 1);
  assert.deepEqual(doc.cels, {});
});

test("edits share untouched cels and drop empty ones", () => {
  const doc = createDoc({ width: 2, height: 1 });
  const [layer] = doc.layers;
  const [frame] = doc.frames;
  const painted = withCel(doc, layer.id, frame.id, new Uint32Array([RED, 0]));
  assert.notEqual(painted.cels, doc.cels);
  assert.deepEqual(Array.from(celPixels(painted, layer.id, frame.id)), [RED, 0]);
  const { doc: twoFrames, id } = addFrame(painted, 0);
  assert.equal(twoFrames.cels[celKey(layer.id, frame.id)], painted.cels[celKey(layer.id, frame.id)]);
  assert.deepEqual(Array.from(celPixels(twoFrames, layer.id, id)), [0, 0]);
  const cleared = withCel(painted, layer.id, frame.id, new Uint32Array(2));
  assert.deepEqual(cleared.cels, {});
});

test("composite blends visible layers bottom to top", () => {
  let doc = createDoc({ width: 3, height: 1 });
  const bottom = doc.layers[0].id;
  const frame = doc.frames[0].id;
  doc = withCel(doc, bottom, frame, new Uint32Array([RED, RED, 0]));
  const added = addLayer(doc, 0);
  doc = withCel(added.doc, added.id, frame, new Uint32Array([0, BLUE, BLUE]));
  assert.deepEqual(Array.from(composite(doc, frame)), [RED, BLUE, BLUE]);
  doc = updateLayer(doc, added.id, { opacity: 0.5 });
  const half = composite(doc, frame);
  assert.equal(half[0], RED);
  assert.equal(half[1] >>> 24, 255, "half blue over opaque red stays opaque");
  assert.equal(half[2] >>> 24, 128, "half blue over nothing is half transparent");
  doc = updateLayer(doc, added.id, { visible: false });
  assert.deepEqual(Array.from(composite(doc, frame)), [RED, RED, 0]);
});

test("layer order, duplicate, merge and remove", () => {
  let doc = createDoc({ width: 2, height: 1 });
  const base = doc.layers[0].id;
  const frame = doc.frames[0].id;
  doc = withCel(doc, base, frame, new Uint32Array([RED, 0]));
  const top = addLayer(doc, 0);
  doc = withCel(top.doc, top.id, frame, new Uint32Array([0, BLUE]));
  const copy = duplicateLayer(doc, top.id);
  assert.deepEqual(copy.doc.layers.map((l) => l.name), ["Layer 1", "Layer 2", "Layer 2 copy"]);
  assert.equal(copy.doc.cels[celKey(copy.id, frame)], doc.cels[celKey(top.id, frame)]);
  assert.deepEqual(moveLayer(doc, top.id, -1).layers.map((l) => l.id), [top.id, base]);
  assert.equal(moveLayer(doc, top.id, 1), doc, "cannot move past the top");
  const merged = mergeDown(doc, top.id);
  assert.equal(merged.layers.length, 1);
  assert.deepEqual(Array.from(celPixels(merged, base, frame)), [RED, BLUE]);
  assert.equal(removeLayer(merged, base), merged, "the last layer stays");
});

test("frames duplicate and remove with their cels", () => {
  let doc = createDoc({ width: 1, height: 1 });
  const layer = doc.layers[0].id;
  const first = doc.frames[0].id;
  doc = withCel(doc, layer, first, new Uint32Array([RED]));
  const dup = duplicateFrame(doc, first);
  assert.deepEqual(dup.doc.frames.map((f) => f.id), [first, dup.id]);
  assert.deepEqual(Array.from(celPixels(dup.doc, layer, dup.id)), [RED]);
  const removed = removeFrame(dup.doc, first);
  assert.deepEqual(removed.frames.map((f) => f.id), [dup.id]);
  assert.equal(removed.cels[celKey(layer, first)], undefined);
});

test("files round-trip through JSON", () => {
  let doc = createDoc({ width: 3, height: 2, name: "Knight" });
  doc = withCel(doc, doc.layers[0].id, doc.frames[0].id, new Uint32Array([RED, 0, BLUE, 0, 0, pack(1, 2, 3, 4)]));
  doc = { ...doc, fps: 12 };
  const back = fromFile(JSON.parse(JSON.stringify(toFile(doc))));
  assert.deepEqual(back, doc);
});

test("bad files are refused with a reason", () => {
  assert.throws(() => fromFile({ format: "other" }), /not a pixel sprite/);
  const file = toFile(createDoc({ width: 2, height: 2 }));
  assert.throws(() => fromFile({ ...file, version: 2 }), /version 2/);
  assert.throws(() => fromFile({ ...file, width: 999 }), /at most 256/);
  const key = celKey(file.layers[0].id, file.frames[0].id);
  assert.throws(() => fromFile({ ...file, cels: { [key]: "AAAA" } }), /wrong size/);
});
