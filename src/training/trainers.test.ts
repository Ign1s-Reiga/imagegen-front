import assert from "node:assert/strict";
import { test } from "node:test";

import { DIFFUSERS_QWEN_IMAGE_21, QWEN_IMAGE_21, TOKEN_PATTERN, derive, family, hasBlocking, suggestToken, trainer } from "./trainers.ts";

const preset = () => DIFFUSERS_QWEN_IMAGE_21.preset(QWEN_IMAGE_21.id, "ohwx");

test("the preset is the upstream example with documented identity choices, and passes its own checks", () => {
  const c = preset();
  // README_qwenimage21.md: lr 1e-4, batch 1, accumulation 4, 500 steps, constant, 8-bit Adam, bf16, 1024.
  assert.equal(c.learningRate, 1e-4);
  assert.equal(c.batchSize, 1);
  assert.equal(c.gradAccum, 4);
  assert.equal(c.maxSteps, 500);
  assert.equal(c.lrScheduler, "constant");
  assert.equal(c.precision, "bf16");
  assert.equal(c.resolution, 1024);
  assert.equal(c.rank, c.alpha);
  assert.ok(c.buckets);
  assert.ok(c.validationPrompts.every((p) => p.includes("ohwx")));
  assert.deepEqual(DIFFUSERS_QWEN_IMAGE_21.validate(c, 20), []);
});

test("blocking problems and warnings", () => {
  const issues = (patch: Partial<ReturnType<typeof preset>>, size = 20) => DIFFUSERS_QWEN_IMAGE_21.validate({ ...preset(), ...patch }, size);
  assert.ok(hasBlocking(issues({ resolution: 1000 })));
  assert.ok(hasBlocking(issues({ validationEvery: 150 })));
  assert.ok(hasBlocking(issues({ checkpointSteps: 600 })));
  assert.ok(hasBlocking(issues({ validationSeeds: [] })));
  assert.ok(hasBlocking(issues({ loraLayers: "to_q; rm" })));
  assert.ok(hasBlocking(issues({}, 0)));
  // Allowed, but explained.
  const alpha = issues({ alpha: 4 });
  assert.equal(hasBlocking(alpha), false);
  assert.match(alpha[0].message, /scales the LoRA by 0.25/);
  assert.equal(hasBlocking(issues({ buckets: false, randomFlip: true })), false);
  assert.equal(issues({ buckets: false, randomFlip: true }).length, 2);
});

test("derived values", () => {
  const d = derive(preset(), 20);
  assert.equal(d.effectiveBatch, 4);
  assert.equal(d.optimizerSteps, 500);
  assert.equal(d.samplesSeen, 2000);
  assert.equal(d.epochs, 100);
  assert.equal(d.checkpoints, 5);
  // Base plus steps 100..500, two prompts, two seeds.
  assert.equal(d.validationPoints, 6);
  assert.equal(d.validationImages, 24);
  assert.equal(derive(preset(), 0).epochs, null);
  const odd = derive({ ...preset(), maxSteps: 450, validationEvery: 200 }, 10);
  assert.equal(odd.checkpoints, 5);
  // 200, 400 and the last step.
  assert.equal(odd.validationPoints, 4);
});

test("lookup and tokens", () => {
  assert.equal(trainer("diffusers-qwenimage21"), DIFFUSERS_QWEN_IMAGE_21);
  assert.equal(trainer("kohya"), null);
  assert.equal(family("qwen-image-2.1"), QWEN_IMAGE_21);
  assert.equal(family("sdxl"), null);
  const token = suggestToken("Alex", ["alex"]);
  assert.match(token, TOKEN_PATTERN);
  assert.notEqual(suggestToken("Alex", [token]), token);
  assert.ok(!TOKEN_PATTERN.test("12345"));
  assert.ok(!TOKEN_PATTERN.test("my token"));
});
