import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NO_MIRROR,
  clampRect,
  drawLine,
  drawRect,
  floodFill,
  linePoints,
  moveRegion,
  pasteRegion,
  rectFromCorners,
  stamp,
  type Target,
} from "./raster.ts";

const target = (width: number, height: number, extra: Partial<Target> = {}): Target => ({
  width,
  height,
  pixels: new Uint32Array(width * height),
  clip: null,
  mirror: NO_MIRROR,
  ...extra,
});

/** Renders pixels as rows of "." (empty) and "#" (set), for readable asserts. */
const show = (t: Target) =>
  Array.from({ length: t.height }, (_, y) =>
    Array.from(t.pixels.subarray(y * t.width, (y + 1) * t.width), (c) => (c ? "#" : ".")).join(""),
  );

test("lines include both ends and stay connected", () => {
  assert.deepEqual(linePoints(0, 0, 3, 1), [[0, 0], [1, 0], [2, 1], [3, 1]]);
  assert.deepEqual(linePoints(2, 2, 2, 2), [[2, 2]]);
  const points = linePoints(5, 0, 0, 3);
  assert.deepEqual(points[0], [5, 0]);
  assert.deepEqual(points.at(-1), [0, 3]);
  for (let i = 1; i < points.length; i++) {
    assert.ok(Math.abs(points[i][0] - points[i - 1][0]) <= 1 && Math.abs(points[i][1] - points[i - 1][1]) <= 1);
  }
});

test("brush sizes and mirroring", () => {
  const t = target(7, 3, { mirror: { x: true, y: false } });
  stamp(t, 0, 1, 2, 1);
  assert.deepEqual(show(t), [".......", "##...##", "##...##"]);
  const both = target(4, 4, { mirror: { x: true, y: true } });
  stamp(both, 0, 0, 1, 1);
  assert.deepEqual(show(both), ["#..#", "....", "....", "#..#"]);
  const u = target(5, 5);
  stamp(u, 2, 2, 3, 1);
  assert.deepEqual(show(u), [".....", ".###.", ".###.", ".###.", "....."]);
});

test("drawing respects the clip rectangle", () => {
  const t = target(5, 1, { clip: { x: 1, y: 0, w: 2, h: 1 } });
  drawLine(t, 0, 0, 4, 0, 1, 1);
  assert.deepEqual(show(t), [".##.."]);
});

test("rectangles: outline, filled, thick", () => {
  const t = target(5, 4);
  drawRect(t, rectFromCorners(4, 3, 0, 0), 1, false);
  assert.deepEqual(show(t), ["#####", "#...#", "#...#", "#####"]);
  const f = target(4, 3);
  drawRect(f, { x: 1, y: 1, w: 2, h: 2 }, 1, true);
  assert.deepEqual(show(f), ["....", ".##.", ".##."]);
  const thick = target(6, 6);
  drawRect(thick, { x: 0, y: 0, w: 6, h: 6 }, 1, false, 2);
  assert.deepEqual(show(thick), ["######", "######", "##..##", "##..##", "######", "######"]);
});

test("flood fill stays inside its region and the clip", () => {
  const t = target(5, 3);
  drawLine(t, 2, 0, 2, 2, 1, 1);
  floodFill(t, 0, 0, 2);
  assert.deepEqual(Array.from(t.pixels), [2, 2, 1, 0, 0, 2, 2, 1, 0, 0, 2, 2, 1, 0, 0]);
  floodFill(t, 0, 0, 2);
  const clipped = target(4, 1, { clip: { x: 0, y: 0, w: 2, h: 1 } });
  floodFill(clipped, 0, 0, 7);
  assert.deepEqual(Array.from(clipped.pixels), [7, 7, 0, 0]);
});

test("moving a region clears its old place and drops what leaves the canvas", () => {
  const base = new Uint32Array([1, 2, 0, 3, 4, 0]);
  assert.deepEqual(Array.from(moveRegion(base, 3, 2, { x: 0, y: 0, w: 2, h: 2 }, 1, 0)), [0, 1, 2, 0, 3, 4]);
  assert.deepEqual(Array.from(moveRegion(base, 3, 2, { x: 0, y: 0, w: 2, h: 2 }, -1, 1)), [0, 0, 0, 2, 0, 0]);
  assert.deepEqual(Array.from(base), [1, 2, 0, 3, 4, 0], "input is not changed");
});

test("paste and clamp", () => {
  const out = pasteRegion(new Uint32Array(4), new Uint32Array([9, 8, 7, 6]), 2, { x: 1, y: 0, w: 1, h: 2 });
  assert.deepEqual(Array.from(out), [0, 8, 0, 6]);
  assert.deepEqual(clampRect({ x: -2, y: 1, w: 5, h: 10 }, 4, 4), { x: 0, y: 1, w: 3, h: 3 });
  assert.equal(clampRect({ x: 5, y: 0, w: 2, h: 2 }, 4, 4), null);
});
