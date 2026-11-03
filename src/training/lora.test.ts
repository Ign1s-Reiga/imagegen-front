import assert from "node:assert/strict";
import { test } from "node:test";

import { applyWorkflow, detectBindings, loraLoader, type ComfyWorkflow, type SavedWorkflow } from "../providers/comfy-workflow.ts";
import type { GenerateParams } from "../providers/types.ts";

import { loraChoice, loraFit, loraOptions, trainedLoraMeta, withTrigger, withoutLora, workflowFamily, type TrainedLora } from "./lora.ts";

const graph = (unet: string, loras = 1): ComfyWorkflow => {
  const g: ComfyWorkflow = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: unet, weight_dtype: "default" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "a photo", clip: ["9", 0] } },
    "3": {
      class_type: "KSampler",
      inputs: { seed: 1, steps: 40, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model: ["10", 0], positive: ["2", 0], negative: ["2", 0], latent_image: ["4", 0] },
    },
    "4": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  };
  for (let i = 0; i < loras; i++) {
    g[String(10 + i)] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["1", 0], lora_name: "old.safetensors", strength_model: 0.5 },
      _meta: { title: `LoRA ${i + 1}` },
    };
  }
  return g;
};

const saved = (g: ComfyWorkflow, bindings = detectBindings(g)): SavedWorkflow => ({ id: "w", name: "Qwen T2I", graph: g, bindings, createdAt: 0 });

const lora: TrainedLora = { id: "a1", family: "qwen-image-2.1", baseModel: "Qwen/Qwen-Image-2.1", triggerToken: "ohwx", step: 400 };

const params = (patch: Partial<GenerateParams>): GenerateParams => ({
  mode: "txt2img",
  prompt: "photo of ohwx person",
  negativePrompt: "",
  model: "",
  width: 1024,
  height: 1024,
  count: 1,
  seed: 7,
  steps: 40,
  cfg: 1,
  sampler: "euler",
  scheduler: "simple",
  strength: 1,
  initImage: null,
  mask: null,
  references: [],
  options: {},
  ...patch,
});

test("a workflow's family comes from the model file it loads", () => {
  const family = (unet: string, model = "") => workflowFamily(saved(graph(unet)), model, ["qwen-image-2.1"]);
  assert.equal(family("qwen_image_2.1_bf16.safetensors"), "qwen-image-2.1");
  assert.equal(family("Qwen-Image-2.1/qwen_image_2.1_fp8.safetensors"), "qwen-image-2.1");
  for (const other of [
    "qwen_image_2.1_turbo_bf16.safetensors",
    "qwen_image_fp8_e4m3fn.safetensors",
    "flux1-dev.safetensors",
    "sd_xl_base_1.0.safetensors",
    "moss_image.safetensors",
  ]) {
    assert.equal(family(other), null, other);
  }
  // The model chosen in the panel stands in for a mapped loader.
  assert.equal(family("flux1-dev.safetensors", "qwen_image_2.1_bf16.safetensors"), "qwen-image-2.1");
});

test("compatibility is checked, and reasons are given", () => {
  const ok = loraFit(lora, "comfyui", saved(graph("qwen_image_2.1_bf16.safetensors")), "");
  assert.deepEqual(ok, { ok: true, loaderTitle: "LoRA 1" });
  const reason = (fit: ReturnType<typeof loraFit>) => (fit.ok ? assert.fail("expected a reason") : fit.reason);
  assert.match(reason(loraFit(lora, "comfyui", saved(graph("flux1-dev.safetensors")), "")), /not interchangeable/);
  assert.match(reason(loraFit(lora, "comfyui", saved(graph("qwen_image_2.1_bf16.safetensors", 0)), "")), /no LoRA loader/);
  assert.match(reason(loraFit(lora, "comfyui", saved(graph("qwen_image_2.1_bf16.safetensors", 2)), "")), /several LoRA loaders/);
  assert.match(reason(loraFit(lora, "comfyui", null, "")), /built-in graph/);
  assert.match(reason(loraFit(lora, "openai", null, "")), /cannot load a LoRA/);
  assert.match(reason(loraFit(lora, "runpod", null, "")), /RunPod serverless/);
});

test("the chosen LoRA and strength go into the workflow's loader", () => {
  const wf = saved(graph("qwen_image_2.1_bf16.safetensors"));
  assert.ok(wf.bindings.some((b) => b.target === "lora" && b.nodeId === "10"));
  const out = applyWorkflow(wf, params({ lora: { name: "imagegen-me-step400.safetensors", strength: 0.8 } }));
  assert.equal(out["10"].inputs.lora_name, "imagegen-me-step400.safetensors");
  assert.equal(out["10"].inputs.strength_model, 0.8);
  // None chosen: the workflow's own setting stays, and the saved graph is untouched.
  const own = applyWorkflow(wf, params({ lora: null }));
  assert.equal(own["10"].inputs.lora_name, "old.safetensors");
  assert.equal(wf.graph["10"].inputs.lora_name, "old.safetensors");
});

test("a workflow saved before LoRA mapping still takes its single loader, and nothing is rewired", () => {
  const g = graph("qwen_image_2.1_bf16.safetensors");
  const old = saved(g, detectBindings(g).filter((b) => b.target !== "lora" && b.target !== "loraStrength"));
  const out = applyWorkflow(old, params({ lora: { name: "x.safetensors", strength: 1 } }));
  assert.equal(out["10"].inputs.lora_name, "x.safetensors");
  const none = saved(graph("qwen_image_2.1_bf16.safetensors", 0));
  assert.throws(() => applyWorkflow(none, params({ lora: { name: "x.safetensors", strength: 1 } })), /no LoRA loader/);
  assert.equal(loraLoader(none), null);
  assert.equal(Object.keys(none.graph).length, 4);
  const two = saved(graph("qwen_image_2.1_bf16.safetensors", 2));
  assert.equal(loraLoader(two), "ambiguous");
  assert.throws(() => applyWorkflow(two, params({ lora: { name: "x.safetensors", strength: 1 } })), /several/);
});

test("the choice is kept in the form options and recorded for metadata", () => {
  const options = { ...loraOptions(lora, "imagegen-me.safetensors", 0.9), seed: "1" };
  assert.deepEqual(loraChoice(options), { name: "imagegen-me.safetensors", strength: 0.9 });
  assert.equal(trainedLoraMeta(options)?.step, 400);
  assert.deepEqual(withoutLora(options), { seed: "1" });
  assert.equal(loraChoice({}), null);
  assert.equal(trainedLoraMeta({ "lora.meta": "{bad" }), null);
});

test("the trigger goes into the prompt once", () => {
  assert.equal(withTrigger("standing in a park", "ohwx"), "photo of ohwx person, standing in a park");
  assert.equal(withTrigger("ohwx at the beach", "ohwx"), "ohwx at the beach");
  assert.equal(withTrigger("", "ohwx"), "photo of ohwx person");
});
