import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PALETTE_PRESETS,
  PaletteMatcher,
  alpha,
  hexToPacked,
  hexToRgb,
  hsvToRgb,
  keyColorFor,
  kmeansPalette,
  oklabToRgb,
  pack,
  packedToHex,
  parseHex,
  rgbToHex,
  rgbToHsv,
  rgbToOklab,
  usedColors,
} from "./color.ts";

test("packing matches ImageData's little-endian Uint32 view", () => {
  const bytes = new Uint8ClampedArray([0x12, 0x34, 0x56, 0x78]);
  assert.equal(new Uint32Array(bytes.buffer)[0], pack(0x12, 0x34, 0x56, 0x78));
  assert.equal(hexToPacked("#123456"), pack(0x12, 0x34, 0x56));
  assert.equal(hexToPacked("12345680"), pack(0x12, 0x34, 0x56, 0x80));
  assert.equal(packedToHex(pack(0xab, 0x0c, 0xff, 3)), "#ab0cff");
  assert.equal(hexToPacked("not a colour"), 0);
});

test("typed hex is normalised or rejected", () => {
  assert.equal(parseHex("#4A82CC"), "#4a82cc");
  assert.equal(parseHex(" 4a82cc "), "#4a82cc");
  assert.equal(parseHex("#f0a"), "#ff00aa");
  assert.equal(parseHex("fa"), null);
  assert.equal(parseHex("#4a82cg"), null);
  assert.equal(parseHex("#4a82cc80"), null, "alpha is not part of a palette colour");
  assert.deepEqual(hexToRgb("#4a82cc"), [0x4a, 0x82, 0xcc]);
  assert.equal(rgbToHex(0x4a, 0x82, 0xcc), "#4a82cc");
});

test("HSV matches known colours", () => {
  const cases: [[number, number, number], [number, number, number]][] = [
    [[255, 0, 0], [0, 1, 1]],
    [[0, 255, 0], [120, 1, 1]],
    [[0, 0, 255], [240, 1, 1]],
    [[255, 0, 128], [329.88, 1, 1]],
    [[128, 128, 128], [0, 0, 0.502]],
    [[74, 130, 204], [214.15, 0.637, 0.8]],
  ];
  for (const [rgb, [h, s, v]] of cases) {
    const hsv = rgbToHsv(...rgb);
    assert.ok(Math.abs(hsv.h - h) < 0.01 && Math.abs(hsv.s - s) < 0.001 && Math.abs(hsv.v - v) < 0.001, `${rgb}: ${JSON.stringify(hsv)}`);
  }
});

test("HSV round-trips every channel value", () => {
  for (let i = 0; i < 256; i += 3) {
    for (const rgb of [[i, 0, 255 - i], [255, i, 40], [i, i, i], [17, 200, i]] as [number, number, number][]) {
      assert.deepEqual(hsvToRgb(rgbToHsv(...rgb)), rgb);
    }
  }
  assert.deepEqual(hsvToRgb({ h: 360, s: 1, v: 1 }), [255, 0, 0], "360° wraps to red");
});

test("HSV keeps hue and saturation where the colour has none", () => {
  const previous = { h: 200, s: 0.6, v: 0.7 };
  assert.deepEqual(rgbToHsv(0, 0, 0, previous), { h: 200, s: 0.6, v: 0 });
  assert.deepEqual(rgbToHsv(90, 90, 90, previous), { h: 200, s: 0, v: 90 / 255 });
  assert.equal(rgbToHsv(0, 0, 0).h, 0);
});

test("OKLab round-trips sRGB", () => {
  for (const [r, g, b] of [[0, 0, 0], [255, 255, 255], [240, 165, 60], [18, 200, 77]]) {
    assert.deepEqual(oklabToRgb(...rgbToOklab(r, g, b)), [r, g, b]);
  }
});

test("palette matcher picks the perceptually nearest colour", () => {
  const palette = ["#000000", "#ffffff", "#ff0000", "#0000ff"].map(hexToPacked);
  const m = new PaletteMatcher(palette);
  assert.equal(m.nearest(20, 10, 10), 0);
  assert.equal(m.nearest(230, 240, 235), 1);
  assert.equal(m.nearest(200, 30, 20), 2);
  assert.equal(m.nearest(30, 40, 210), 3);
  assert.throws(() => new PaletteMatcher([]), /empty/);
});

test("k-means keeps distinct clusters and is deterministic", () => {
  const colors = [
    pack(250, 10, 10), pack(240, 20, 15), pack(10, 10, 240), pack(20, 15, 250), pack(245, 245, 245),
  ];
  const weights = [10, 8, 9, 7, 30];
  const a = kmeansPalette(colors, weights, 3);
  assert.equal(a.length, 3);
  assert.deepEqual(a, kmeansPalette(colors, weights, 3));
  const m = new PaletteMatcher(a);
  // Each cluster lands on its own palette entry.
  assert.equal(new Set([m.nearest(250, 10, 10), m.nearest(10, 10, 240), m.nearest(245, 245, 245)]).size, 3);
  assert.equal(kmeansPalette(colors.slice(0, 2), [1, 1], 8).length, 2, "fewer colours than k are kept as is");
});

test("used colours skip transparency and ignore alpha", () => {
  const a = new Uint32Array([0, pack(1, 2, 3), pack(1, 2, 3, 100), pack(9, 9, 9)]);
  const used = usedColors([a]);
  assert.equal(used.length, 2);
  assert.ok(used.every((c) => alpha(c) === 255));
});

test("key colour stays clear of the palette", () => {
  const magentaHeavy = ["#ff00ff", "#ee11ee", "#ff22dd"].map(hexToPacked);
  assert.notEqual(keyColorFor(magentaHeavy), hexToPacked("#ff00ff"));
  assert.equal(keyColorFor([]), hexToPacked("#ff00ff"));
});

test("presets are valid hex colours", () => {
  for (const preset of PALETTE_PRESETS) {
    assert.ok(preset.colors.length >= 2, preset.name);
    for (const c of preset.colors) assert.match(c, /^#[0-9a-f]{6}$/, `${preset.name} ${c}`);
    assert.equal(new Set(preset.colors).size, preset.colors.length, `${preset.name} has duplicates`);
  }
});
