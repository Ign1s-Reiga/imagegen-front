import assert from "node:assert/strict";
import { test } from "node:test";

import { hexToPacked, pack, type Packed } from "./color.ts";
import { clearEdgeBackground, cropToAspect, edgesMostlyClear, snapToGrid, type RgbaImage } from "./snap.ts";

/** A fake "pixel art" render: each sprite pixel drawn as a scale×scale block, edges blurred. */
function render(sprite: Packed[][], scale: number, blur = true): RgbaImage {
  const rows = sprite.length;
  const cols = sprite[0].length;
  const width = cols * scale;
  const height = rows * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = sprite[Math.floor(y / scale)][Math.floor(x / scale)];
      // Smear the first column of every block with its left neighbour, like a soft edge.
      if (blur && x % scale === 0 && x > 0) c = sprite[Math.floor(y / scale)][Math.floor(x / scale) - 1];
      const o = (y * width + x) * 4;
      data[o] = c & 0xff;
      data[o + 1] = (c >>> 8) & 0xff;
      data[o + 2] = (c >>> 16) & 0xff;
      data[o + 3] = c >>> 24;
    }
  }
  return { width, height, data };
}

const R = hexToPacked("#d03030");
const B = hexToPacked("#2040c0");
const W = hexToPacked("#f0f0f0");
const K = hexToPacked("#101010");

test("snaps blurred blocks back to exact sprite pixels", () => {
  const sprite = [
    [W, W, W, W],
    [W, R, B, W],
    [W, K, R, W],
    [W, W, W, W],
  ];
  const { pixels, palette } = snapToGrid(render(sprite, 16), { width: 4, height: 4, palette: [K, R, B, W] });
  assert.deepEqual(Array.from(pixels), sprite.flat());
  assert.deepEqual(palette, [K, R, B, W]);
});

test("slightly off colours land on the nearest palette entry", () => {
  const off = pack(200, 50, 45);
  const { pixels } = snapToGrid(render([[off, W]], 10, false), { width: 2, height: 1, palette: [R, W, K] });
  assert.deepEqual(Array.from(pixels), [R, W]);
});

test("removes the background that touches the edges, keeps enclosed areas", () => {
  const sprite = [
    [W, W, W, W, W],
    [W, K, K, K, W],
    [W, K, W, K, W],
    [W, K, K, K, W],
    [W, W, W, W, W],
  ];
  const { pixels, palette } = snapToGrid(render(sprite, 8), { width: 5, height: 5, palette: [K, W], removeBackground: true });
  const shown = Array.from(pixels, (c) => (c === 0 ? "." : c === K ? "k" : "w")).join("");
  assert.equal(shown, "......kkk..kwk..kkk......");
  assert.deepEqual(palette, [K, W]);
});

test("the key colour becomes transparent and is not reported", () => {
  const key = hexToPacked("#ff00ff");
  const { pixels, palette } = snapToGrid(render([[key, R, key]], 8), { width: 3, height: 1, palette: [R, W], keyColor: key });
  assert.deepEqual(Array.from(pixels), [0, R, 0]);
  assert.deepEqual(palette, [R]);
});

test("picks a new palette when none is given", () => {
  const sprite = [
    [R, R, B, B],
    [R, R, B, B],
    [W, W, K, K],
    [W, W, K, K],
  ];
  const { pixels, palette } = snapToGrid(render(sprite, 12), { width: 4, height: 4, palette: null, colors: 4 });
  assert.equal(palette.length, 4);
  assert.equal(new Set(pixels).size, 4);
  // Same layout: equal sprite pixels map to equal output pixels.
  const flat = sprite.flat();
  for (let i = 0; i < flat.length; i++) {
    for (let j = 0; j < flat.length; j++) assert.equal(flat[i] === flat[j], pixels[i] === pixels[j]);
  }
});

test("crops the source to the sprite's aspect ratio", () => {
  const image = { width: 1536, height: 1024, data: new Uint8ClampedArray(0) };
  assert.deepEqual(cropToAspect(image, 32, 32), { x: 256, y: 0, w: 1024, h: 1024 });
  assert.deepEqual(cropToAspect(image, 48, 32), { x: 0, y: 0, w: 1536, h: 1024 });
  const tall = cropToAspect({ width: 1024, height: 1024, data: new Uint8ClampedArray(0) }, 16, 32);
  assert.deepEqual(tall, { x: 256, y: 0, w: 512, h: 1024 });
});

test("transparent source pixels stay transparent", () => {
  const { pixels } = snapToGrid(render([[0, R]], 8, false), { width: 2, height: 1, palette: [R] });
  assert.deepEqual(Array.from(pixels), [0, R]);
});

test("tells sprites with clear edges from full scenes", () => {
  const sprite = new Uint32Array(16);
  sprite[5] = sprite[6] = R;
  assert.equal(edgesMostlyClear(sprite, 4, 4), true);
  assert.equal(edgesMostlyClear(new Uint32Array(16).fill(B), 4, 4), false);
  assert.equal(edgesMostlyClear(new Uint32Array([0]), 1, 1), true);
});

test("edge background is left alone when no colour dominates the edges", () => {
  const indices = Int32Array.from([0, 1, 2, 3, 0, 1, 2, 3, 0]);
  clearEdgeBackground(indices, 3, 3);
  assert.deepEqual(Array.from(indices), [0, 1, 2, 3, 0, 1, 2, 3, 0]);
});
