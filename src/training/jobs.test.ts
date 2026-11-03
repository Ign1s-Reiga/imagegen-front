import assert from "node:assert/strict";
import { test } from "node:test";

import { canCancel, canResume, costEstimate, needsPolling, runDisplay, runProgress, validationGrid, type RunRecord } from "./jobs.ts";
import { DIFFUSERS_QWEN_IMAGE_21 } from "./trainers.ts";

const run = (patch: Partial<RunRecord>): RunRecord => ({
  id: "r",
  projectId: "p",
  createdAt: 0,
  hostId: "h",
  hostLabel: "Pod",
  snapshot: {
    trainer: "diffusers-qwenimage21",
    trainerVersion: "diffusers-0.42.1",
    family: "qwen-image-2.1",
    baseModel: "Qwen/Qwen-Image-2.1",
    baseRevision: "abc",
    triggerToken: "ohwx",
    instancePrompt: "photo of ohwx person",
    conversion: "v1",
    config: DIFFUSERS_QWEN_IMAGE_21.preset("qwen-image-2.1", "ohwx"),
    items: [],
    datasetHash: "d",
  },
  datasetHash: "d",
  remoteDir: "/w/jobs/r",
  state: "training",
  remote: { state: "training", step: 100, maxSteps: 500, loss: 0.1, startedAt: 1000, now: 1300, secondsPerStep: 3 },
  connection: "ok",
  connectionError: null,
  checkedAt: 1,
  updatedAt: 1,
  validationFiles: {},
  ...patch,
});

test("a lost connection is not a failure", () => {
  const lost = run({ connection: "lost", connectionError: "timed out" });
  const display = runDisplay(lost);
  assert.equal(display.tone, "unknown");
  assert.match(display.label, /Training, as last seen/);
  assert.match(display.detail!, /keeps going on the host/);
  assert.ok(needsPolling(lost));
  // Cancel stays available; it is what reconnecting is for.
  assert.ok(canCancel(lost));
  // A finished run stays finished whatever the connection.
  assert.equal(runDisplay(run({ state: "completed", connection: "lost" })).tone, "ok");
});

test("failure and cancellation report the host's words", () => {
  const failed = run({ state: "failed", remote: { state: "failed", error: { kind: "oom", message: "The GPU ran out of memory." } } });
  assert.equal(runDisplay(failed).tone, "error");
  assert.equal(runDisplay(failed).detail, "The GPU ran out of memory.");
  assert.equal(runDisplay(run({ state: "missing" })).tone, "error");
  assert.match(runDisplay(run({ state: "uploading" })).label, /interrupted/);
});

test("resume only from a checkpoint with training state", () => {
  const stopped = (resumeStep: number | null, state: RunRecord["state"] = "cancelled") =>
    run({ state, remote: { state, resumeStep, checkpoints: [] } });
  assert.ok(canResume(stopped(200)));
  assert.ok(canResume(stopped(200, "failed")));
  // The host found only exported LoRA files.
  assert.ok(!canResume(stopped(null)));
  assert.ok(!canResume(stopped(200, "completed")));
  assert.ok(!canResume({ ...stopped(200), connection: "lost" }));
});

test("progress uses measured numbers only", () => {
  const p = runProgress(run({}));
  assert.equal(p.step, 100);
  assert.equal(p.elapsed, 300);
  assert.equal(p.remaining, 1200);
  assert.equal(costEstimate(p.remaining, 2), (1200 / 3600) * 2);
  assert.equal(costEstimate(p.remaining, null), null);
  const early = runProgress(run({ state: "preparing", remote: { state: "preparing" } }));
  assert.equal(early.step, null);
  assert.equal(early.secondsPerStep, null);
  assert.equal(early.remaining, null);
  assert.equal(early.maxSteps, 500);
});

test("validation images line up by step, prompt and seed", () => {
  const grid = validationGrid(
    run({
      state: "completed",
      remote: {
        state: "completed",
        validation: {
          prompts: ["a", "b"],
          seeds: [1],
          images: [
            { step: 200, label: "200", prompt: 0, seed: 1, file: "200/0-1.png" },
            { step: null, label: "base", prompt: 0, seed: 1, file: "base/0-1.png" },
            { step: 100, label: "100", prompt: 1, seed: 1, file: "100/1-1.png" },
          ],
        },
      },
      validationFiles: { "200/0-1.png": "C:/x/200.png", "base/0-1.png": "C:/x/base.png" },
    }),
  );
  assert.deepEqual(grid.labels, ["base", "100", "200"]);
  assert.equal(grid.cell("200", 0, 1), "C:/x/200.png");
  // Reported by the host but not downloaded yet.
  assert.equal(grid.cell("100", 1, 1), null);
  assert.equal(grid.cell("100", 0, 1), null);
});
