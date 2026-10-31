import assert from "node:assert/strict";
import { test } from "node:test";

import { mapToSchema, type SchemaProps } from "./schema-input.ts";
import type { GenerateParams } from "./types.ts";

const params = (mode: "txt2img" | "img2img"): GenerateParams => ({
  mode, prompt: "p", negativePrompt: "", model: "", width: 1024, height: 1024, count: 1, seed: 1, steps: 0, cfg: 0,
  sampler: "", scheduler: "", strength: 0.6, initImage: null, mask: null, references: [], options: {},
});

test("references go to a list input, after the input image", () => {
  const props: SchemaProps = { prompt: {}, image_urls: {}, strength: {} };
  assert.deepEqual(mapToSchema(props, params("txt2img"), { references: ["a", "b"] }).image_urls, ["a", "b"]);
  assert.deepEqual(mapToSchema(props, params("img2img"), { init: "i", references: ["a"] }).image_urls, ["i", "a"]);
});

test("one reference fits a single image input; more do not", () => {
  const props: SchemaProps = { prompt: {}, image_url: {} };
  assert.equal(mapToSchema(props, params("txt2img"), { references: ["a"] }).image_url, "a");
  assert.throws(() => mapToSchema(props, params("txt2img"), { references: ["a", "b"] }), /takes one image/);
  assert.throws(() => mapToSchema({ prompt: {} }, params("txt2img"), { references: ["a"] }), /takes no images/);
});

test("without references, image to image works as before", () => {
  const props: SchemaProps = { prompt: {}, image_url: {}, strength: {} };
  const input = mapToSchema(props, params("img2img"), { init: "i" });
  assert.equal(input.image_url, "i");
  assert.equal(input.strength, 0.6);
});
