import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyWorkflow,
  buildComfyWorkflow,
  detectBindings,
  referenceUploadName,
  unsupportedReferenceTitles,
  upgradeReferenceBindings,
  uploadReferences,
  workflowCapabilities,
  workflowReferenceProblem,
  type ComfyWorkflow,
  type SavedWorkflow,
} from "./comfy-workflow.ts";
import type { Capabilities, GenerateParams, InputImage } from "./types.ts";

const BASE_CAPS: Capabilities = {
  img2img: true,
  mask: true,
  negativePrompt: true,
  seed: true,
  steps: true,
  cfg: true,
  sampler: true,
  scheduler: true,
  strength: true,
  size: true,
  model: true,
  maxCount: 16,
  references: 0,
  sizeStep: 8,
};

const image = (name: string, byte: number): InputImage => ({
  bytes: new Uint8Array([byte, byte, byte]),
  mime: "image/png",
  name,
  width: 64,
  height: 64,
});

const params = (patch: Partial<GenerateParams> = {}): GenerateParams => ({
  mode: "txt2img",
  prompt: "a quiet harbour at dawn",
  negativePrompt: "blurry, watermark",
  model: "",
  width: 1920,
  height: 1080,
  count: 1,
  seed: 42,
  steps: 30,
  cfg: 4,
  sampler: "",
  scheduler: "",
  strength: 0.6,
  initImage: null,
  mask: null,
  references: [],
  options: {},
  ...patch,
});

/**
 * A two-reference edit graph shaped like the MOSS one: split loaders, an edit
 * LoRA, skip layer guidance, and one encoder giving the positive, negative and
 * latent outputs. Reference 2 has the lower node id and comes first in the
 * JSON, so order by id or by property would swap them.
 */
function mossGraph(): ComfyWorkflow {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "pornmaster-moss.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "text-encoder-vision.safetensors", type: "moss" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "moss-vae.safetensors" } },
    "4": {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["1", 0], lora_name: "moss-image-edit-hq-v3.safetensors", strength_model: 1 },
    },
    "5": { class_type: "LoadImage", inputs: { image: "person.png" }, _meta: { title: "Reference 2 — Person" } },
    "6": { class_type: "LoadImage", inputs: { image: "composition.png" }, _meta: { title: "Reference 1 — Composition" } },
    "7": {
      class_type: "MOSSImageEditTextEncode",
      inputs: {
        clip: ["2", 0],
        vae: ["3", 0],
        image1: ["6", 0],
        image2: ["5", 0],
        prompt: "saved prompt",
        negative_prompt: "saved negative",
        width: 1024,
        height: 1024,
      },
    },
    "8": { class_type: "SkipLayerGuidanceDiT", inputs: { model: ["4", 0], double_layers: "7, 8, 9", scale: 3 } },
    "9": {
      class_type: "KSampler",
      inputs: {
        model: ["8", 0],
        positive: ["7", 0],
        negative: ["7", 1],
        latent_image: ["7", 2],
        seed: 1,
        steps: 28,
        cfg: 4,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1,
      },
    },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
    "11": { class_type: "SaveImage", inputs: { filename_prefix: "moss", images: ["10", 0] } },
  };
}

const saved = (graph: ComfyWorkflow, name = "MOSS edit"): SavedWorkflow => ({
  id: "wf",
  name,
  graph,
  bindings: detectBindings(graph),
  createdAt: 0,
});

const targetOf = (workflow: SavedWorkflow, nodeId: string, input: string) =>
  workflow.bindings.find((b) => b.nodeId === nodeId && b.input === input)?.target;

test("reference inputs are found by the number in the node title, not the node id", () => {
  const wf = saved(mossGraph());
  assert.equal(targetOf(wf, "6", "image"), "reference1");
  assert.equal(targetOf(wf, "5", "image"), "reference2");
  // Neither is taken for the ordinary input image.
  assert.equal(wf.bindings.some((b) => b.target === "initImage"), false);
  const caps = workflowCapabilities(wf, BASE_CAPS);
  assert.equal(caps.references, 2);
  assert.equal(caps.img2img, false);
  assert.equal(caps.img2imgOnly, false);
});

test("both attached images reach their own reference inputs", () => {
  const wf = saved(mossGraph());
  const graph = applyWorkflow(wf, params({ references: [image("a.png", 1), image("b.png", 2)] }), {
    references: ["imagegen-ref1-x.png", "uploads/imagegen-ref2-y.png"],
  });
  assert.equal(graph["6"].inputs.image, "imagegen-ref1-x.png");
  assert.equal(graph["5"].inputs.image, "uploads/imagegen-ref2-y.png");
});

test("reference order holds with the node ids reversed", () => {
  const graph = mossGraph();
  // Swap which node is which reference: now the higher id is Reference 2.
  graph["5"]._meta = { title: "Reference 1 — Composition" };
  graph["6"]._meta = { title: "Reference 2 — Person" };
  const wf = saved(graph);
  const applied = applyWorkflow(wf, params(), { references: ["first.png", "second.png"] });
  assert.equal(applied["5"].inputs.image, "first.png");
  assert.equal(applied["6"].inputs.image, "second.png");
});

test("MOSS positive and negative prompts map to separate inputs and change independently", () => {
  const wf = saved(mossGraph());
  assert.equal(targetOf(wf, "7", "prompt"), "prompt");
  assert.equal(targetOf(wf, "7", "negative_prompt"), "negativePrompt");
  assert.equal(workflowCapabilities(wf, BASE_CAPS).negativePrompt, true);

  const refs = { references: ["r1.png", "r2.png"] };
  const a = applyWorkflow(wf, params({ prompt: "one", negativePrompt: "two" }), refs);
  assert.equal(a["7"].inputs.prompt, "one");
  assert.equal(a["7"].inputs.negative_prompt, "two");
  const b = applyWorkflow(wf, params({ prompt: "one", negativePrompt: "three" }), refs);
  assert.equal(b["7"].inputs.prompt, "one");
  assert.equal(b["7"].inputs.negative_prompt, "three");
});

test("a reference edit keeps its latent, its denoise of 1 and every unmapped input", () => {
  const wf = saved(mossGraph());
  const graph = applyWorkflow(wf, params({ model: "other-moss.safetensors", steps: 20 }), {
    references: ["r1.png", "r2.png"],
  });
  assert.deepEqual(graph["9"].inputs.latent_image, ["7", 2]);
  assert.equal(graph["9"].inputs.denoise, 1);
  assert.equal(graph["9"].inputs.steps, 20);
  assert.equal(graph["1"].inputs.unet_name, "other-moss.safetensors");
  assert.equal(Object.values(graph).some((n) => n.class_type === "VAEEncode" || n.class_type === "CheckpointLoaderSimple"), false);
  // Text encoder, VAE, edit LoRA and skip layer guidance are left as exported,
  // and so is the encoder's size, which nothing maps.
  for (const id of ["2", "3", "4", "8"]) assert.deepEqual(graph[id], mossGraph()[id]);
  assert.equal(graph["7"].inputs.width, 1024);
  assert.equal(graph["7"].inputs.height, 1024);
});

test("applying parameters does not change the saved workflow", () => {
  const wf = saved(mossGraph());
  const before = structuredClone(wf);
  applyWorkflow(wf, params({ prompt: "changed", references: [image("a.png", 1), image("b.png", 2)] }), {
    references: ["r1.png", "r2.png"],
  });
  assert.deepEqual(wf, before);
});

test("a missing reference is reported and never falls back to the saved file name", () => {
  const wf = saved(mossGraph());
  const problem = workflowReferenceProblem(wf, 1);
  assert.ok(problem);
  assert.match(problem, /Reference 2 — Person/);
  assert.match(workflowReferenceProblem(wf, 0) ?? "", /Reference 1 — Composition, Reference 2 — Person/);
  assert.equal(workflowReferenceProblem(wf, 2), null);
  // Even past the check, the graph is never sent with person.png or composition.png.
  assert.throws(() => applyWorkflow(wf, params(), { references: ["r1.png"] }), /Reference 2/);
  assert.throws(() => applyWorkflow(wf, params(), {}), /No image was uploaded for Reference/);
});

test("an attachment with no reference input is rejected", () => {
  const wf = saved(mossGraph());
  assert.match(workflowReferenceProblem(wf, 3) ?? "", /reference image 3/);
  // A gap: Reference 1 and 3 mapped, but nothing takes image 2.
  const graph = mossGraph();
  graph["5"]._meta = { title: "Reference 3 — Person" };
  const gapped = saved(graph);
  assert.equal(workflowCapabilities(gapped, BASE_CAPS).references, 3);
  // Whatever is attached, the answer is to fix the workflow's numbering.
  for (const count of [0, 1, 2, 3]) {
    assert.match(workflowReferenceProblem(gapped, count) ?? "", /maps Reference 3 but not Reference 2, so it cannot run/);
  }
  // Two missing numbers are both asked for.
  const wide = mossGraph();
  wide["5"]._meta = { title: "Reference 4 — Person" };
  assert.match(
    workflowReferenceProblem(saved(wide), 4) ?? "",
    /but not Reference 2 and Reference 3, so it cannot run\. In the workflow inputs, map a LoadImage node to each of Reference 2 and Reference 3,/,
  );
});

test("images with the same file name are uploaded under different names", async () => {
  // A server that, like ComfyUI with overwrite on, keeps the last file per name.
  const server = new Map<string, number>();
  const sent: string[] = [];
  const names = await uploadReferences([image("image.png", 1), image("image.png", 2)], async (img, name) => {
    sent.push(name);
    server.set(name, img.bytes[0]);
    return `uploads/${name}`;
  });
  assert.notEqual(sent[0], sent[1]);
  assert.match(sent[0], /^imagegen-ref-[0-9a-f]{32}\.png$/);
  assert.deepEqual([...server.values()], [1, 2]);
  // The names the server reported are the ones returned, in order.
  assert.deepEqual(names, sent.map((n) => `uploads/${n}`));
});

test("two loaders with the same reference number both get its image", () => {
  const graph = mossGraph();
  graph["12"] = { class_type: "LoadImage", inputs: { image: "old-face.png" }, _meta: { title: "Reference 1 — Face crop" } };
  const wf = saved(graph);
  assert.equal(targetOf(wf, "6", "image"), "reference1");
  assert.equal(targetOf(wf, "12", "image"), "reference1");
  assert.equal(workflowCapabilities(wf, BASE_CAPS).references, 2);
  const applied = applyWorkflow(wf, params(), { references: ["r1.png", "r2.png"] });
  assert.equal(applied["6"].inputs.image, "r1.png");
  assert.equal(applied["12"].inputs.image, "r1.png");
});

test("uploads run at once and still come back in attachment order", async () => {
  let inFlight = 0;
  let most = 0;
  // The first upload is the slowest, so finishing order is reversed.
  const delays = [30, 10, 0];
  const names = await uploadReferences([image("a.png", 1), image("b.png", 2), image("c.png", 3)], async (img, name) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setTimeout(resolve, delays[img.bytes[0] - 1]));
    inFlight--;
    return `${img.bytes[0]}:${name}`;
  });
  assert.equal(most, 3);
  assert.deepEqual(
    names.map((n) => n.split(":")[0]),
    ["1", "2", "3"],
  );
});

test("the same image always gets the same upload name, so repeat runs reuse one file", async () => {
  const a = await referenceUploadName(image("first.png", 7));
  const b = await referenceUploadName(image("renamed.png", 7));
  const c = await referenceUploadName(image("first.png", 8));
  assert.equal(a, b);
  assert.notEqual(a, c);
  // Three runs with the same two images leave two files, not six.
  const server = new Set<string>();
  for (let run = 0; run < 3; run++) {
    await uploadReferences([image("a.png", 1), image("b.png", 2)], async (_img, name) => {
      server.add(name);
      return name;
    });
  }
  assert.equal(server.size, 2);
});

test("other LoadImage nodes keep their ordinary roles", () => {
  const graph = mossGraph();
  graph["12"] = { class_type: "LoadImage", inputs: { image: "watermark.png" }, _meta: { title: "Logo" } };
  const wf = saved(graph);
  // An untitled loader is still the input image, as before; Reference inputs are not.
  assert.equal(targetOf(wf, "12", "image"), "initImage");
  assert.equal(targetOf(wf, "6", "image"), "reference1");
});

test("a reference title past 4 is mapped to nothing and reported, not taken as the input image", () => {
  const graph = mossGraph();
  graph["12"] = { class_type: "LoadImage", inputs: { image: "extra.png" }, _meta: { title: "Reference 5 — Lighting" } };
  // "Reference 12" is not Reference 1 either.
  graph["13"] = { class_type: "LoadImage", inputs: { image: "other.png" }, _meta: { title: "Reference 12" } };
  const wf = saved(graph);
  assert.equal(targetOf(wf, "12", "image"), undefined);
  assert.equal(targetOf(wf, "13", "image"), undefined);
  assert.equal(workflowCapabilities(wf, BASE_CAPS).img2imgOnly, false);
  assert.deepEqual(unsupportedReferenceTitles(graph), ["Reference 5 — Lighting", "Reference 12"]);
  assert.deepEqual(unsupportedReferenceTitles(mossGraph()), []);
});

test("a workflow saved before 0.2.0 has its Reference loaders mapped to references", () => {
  const graph = mossGraph();
  graph["12"] = { class_type: "LoadImage", inputs: { image: "input.png" }, _meta: { title: "Load Image" } };
  // As 0.1.x saved it: the first LoadImage as the input image, the rest unmapped.
  const old: SavedWorkflow = {
    ...saved(graph),
    bindings: [
      ...saved(graph).bindings.filter((b) => !b.target.startsWith("reference") && b.target !== "initImage"),
      { nodeId: "5", input: "image", target: "initImage" },
    ],
  };
  const upgraded = upgradeReferenceBindings(old);
  assert.equal(targetOf(upgraded, "5", "image"), "reference2");
  assert.equal(workflowCapabilities(upgraded, BASE_CAPS).img2imgOnly, false);
  // Bindings it does not concern, and workflows with nothing to move, are left alone.
  const current = saved(graph);
  assert.equal(upgradeReferenceBindings(current), current);
  const plain = saved(img2imgGraph());
  assert.equal(upgradeReferenceBindings(plain), plain);
});

/** An ordinary img2img graph with an input image and a mask. */
function img2imgGraph(): ComfyWorkflow {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl.safetensors" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "pos", clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "neg", clip: ["4", 1] } },
    "10": { class_type: "LoadImage", inputs: { image: "input.png" }, _meta: { title: "Load Image" } },
    "14": { class_type: "LoadImageMask", inputs: { image: "mask.png", channel: "red" } },
    "12": { class_type: "VAEEncode", inputs: { pixels: ["10", 0], vae: ["4", 2] } },
    "17": { class_type: "SetLatentNoiseMask", inputs: { samples: ["12", 0], mask: ["14", 0] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: 1,
        steps: 25,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 0.75,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["17", 0],
      },
    },
  };
}

test("ordinary img2img and mask workflows work as before", () => {
  const wf = saved(img2imgGraph(), "Inpaint");
  assert.equal(targetOf(wf, "10", "image"), "initImage");
  assert.equal(targetOf(wf, "14", "image"), "mask");
  assert.equal(targetOf(wf, "6", "text"), "prompt");
  assert.equal(targetOf(wf, "7", "text"), "negativePrompt");
  const caps = workflowCapabilities(wf, BASE_CAPS);
  assert.equal(caps.img2imgOnly, true);
  assert.equal(caps.mask, true);
  assert.equal(caps.references, 0);
  assert.equal(workflowReferenceProblem(wf, 0), null);

  const graph = applyWorkflow(wf, params({ mode: "img2img", strength: 0.4 }), { initImage: "up.png", mask: "up-mask.png" });
  assert.equal(graph["10"].inputs.image, "up.png");
  assert.equal(graph["14"].inputs.image, "up-mask.png");
  assert.equal(graph["3"].inputs.denoise, 0.4);
  assert.deepEqual(graph["3"].inputs.latent_image, ["17", 0]);
});

test("the built-in graph still encodes the input image and mask for img2img", () => {
  const graph = buildComfyWorkflow(params({ mode: "img2img", strength: 0.5 }), "sdxl.safetensors", {
    initImage: "in.png",
    mask: "m.png",
  });
  assert.equal(graph["10"].inputs.image, "in.png");
  assert.equal(graph["14"].inputs.image, "m.png");
  assert.equal(graph["12"].class_type, "VAEEncode");
  assert.equal(graph["3"].inputs.denoise, 0.5);
});
