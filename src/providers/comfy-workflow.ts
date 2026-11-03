import { extForMime } from "../lib/bytes.ts";

import type { Capabilities, GenerateParams, InputImage } from "./types";

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}

export type ComfyWorkflow = Record<string, ComfyNode>;

export const SAVE_NODE_ID = "9";

/**
 * The current `SavedWorkflow.bindingsVersion`: 1 has reference loaders mapped
 * as 0.2.2 and 0.2.3 did, 2 (0.2.4 on) also has none mapped whose image is
 * wired from another node.
 */
export const BINDINGS_VERSION = 2;

/** File names a generation uploaded to Comfy's input folder. */
export interface UploadedRefs {
  initImage?: string;
  mask?: string;
  /** The attached reference images, in order: the first goes to Reference 1. */
  references?: string[];
}

/**
 * Builds a standard checkpoint workflow in ComfyUI's API format.
 * img2img loads the input from Comfy's input folder, scales it to the
 * requested size and encodes it as the starting latent. A mask (white =
 * change) goes through the same scaling and limits where noise is added.
 */
export function buildComfyWorkflow(params: GenerateParams, checkpoint: string, refs: UploadedRefs = {}): ComfyWorkflow {
  const workflow: ComfyWorkflow = {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: checkpoint },
      _meta: { title: "Load Checkpoint" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.prompt, clip: ["4", 1] },
      _meta: { title: "Positive" },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: params.negativePrompt, clip: ["4", 1] },
      _meta: { title: "Negative" },
    },
  };

  const scale = (image: [string, number]) => ({
    class_type: "ImageScale",
    inputs: { image, upscale_method: "lanczos", width: params.width, height: params.height, crop: "center" },
  });

  let latent: [string, number];
  let denoise = 1;
  if (params.mode === "img2img" && refs.initImage) {
    workflow["10"] = { class_type: "LoadImage", inputs: { image: refs.initImage } };
    workflow["11"] = scale(["10", 0]);
    workflow["12"] = { class_type: "VAEEncode", inputs: { pixels: ["11", 0], vae: ["4", 2] } };
    latent = ["12", 0];
    if (refs.mask) {
      workflow["14"] = { class_type: "LoadImage", inputs: { image: refs.mask } };
      workflow["15"] = scale(["14", 0]);
      workflow["16"] = { class_type: "ImageToMask", inputs: { image: ["15", 0], channel: "red" } };
      workflow["17"] = { class_type: "SetLatentNoiseMask", inputs: { samples: latent, mask: ["16", 0] } };
      latent = ["17", 0];
    }
    if (params.count > 1) {
      workflow["13"] = { class_type: "RepeatLatentBatch", inputs: { samples: latent, amount: params.count } };
      latent = ["13", 0];
    }
    denoise = params.strength;
  } else {
    workflow["5"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: params.width, height: params.height, batch_size: params.count },
    };
    latent = ["5", 0];
  }

  workflow["3"] = {
    class_type: "KSampler",
    inputs: {
      seed: params.seed,
      steps: params.steps,
      cfg: params.cfg,
      sampler_name: params.sampler || "euler",
      scheduler: params.scheduler || "normal",
      denoise,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: latent,
    },
  };
  workflow["8"] = { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } };
  workflow[SAVE_NODE_ID] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: "imagegen", images: ["8", 0] },
  };
  return workflow;
}

/** Reads a combo input's choices from /object_info, old or new format. */
export function comboChoices(spec: unknown): string[] {
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options.map(String);
  return [];
}

// ---------------------------------------------------------------------------
// Imported workflows
// ---------------------------------------------------------------------------

/** App parameters a workflow input can be driven by. */
export type WorkflowParam =
  | "prompt"
  | "negativePrompt"
  | "seed"
  | "steps"
  | "cfg"
  | "sampler"
  | "scheduler"
  | "strength"
  | "width"
  | "height"
  | "count"
  | "model"
  | "initImage"
  | "mask"
  | "lora"
  | "loraStrength"
  | ReferenceParam;

/** Reference inputs an imported workflow can map, numbered like the prompt's attachments. */
export const REFERENCE_PARAMS = ["reference1", "reference2", "reference3", "reference4"] as const;
export type ReferenceParam = (typeof REFERENCE_PARAMS)[number];

/** 1 for "reference1", and so on; null for any other target. */
export function referenceNumber(target: string): number | null {
  const index = (REFERENCE_PARAMS as readonly string[]).indexOf(target);
  return index < 0 ? null : index + 1;
}

export const WORKFLOW_PARAMS: { value: WorkflowParam; label: string; kind: "string" | "number" }[] = [
  { value: "prompt", label: "Prompt", kind: "string" },
  { value: "negativePrompt", label: "Avoid (negative prompt)", kind: "string" },
  { value: "model", label: "Model", kind: "string" },
  { value: "initImage", label: "Input image", kind: "string" },
  { value: "mask", label: "Mask", kind: "string" },
  ...REFERENCE_PARAMS.map((value, i) => ({ value, label: `Reference ${i + 1}`, kind: "string" as const })),
  { value: "sampler", label: "Sampler", kind: "string" },
  { value: "scheduler", label: "Scheduler", kind: "string" },
  { value: "seed", label: "Seed", kind: "number" },
  { value: "steps", label: "Steps", kind: "number" },
  { value: "cfg", label: "Guidance", kind: "number" },
  { value: "strength", label: "Change amount (denoise)", kind: "number" },
  { value: "width", label: "Width", kind: "number" },
  { value: "height", label: "Height", kind: "number" },
  { value: "count", label: "Images (batch size)", kind: "number" },
  { value: "lora", label: "LoRA file", kind: "string" },
  { value: "loraStrength", label: "LoRA strength", kind: "number" },
];

/** ComfyUI's LoRA loaders: the model-only one and the one that also patches CLIP. */
export const LORA_LOADER = /^(LoraLoaderModelOnly|LoraLoader)$/;

/** A LoRA chosen for a run, by the file name ComfyUI lists. */
export interface LoraChoice {
  name: string;
  strength: number;
}

/**
 * The loader a chosen LoRA goes into: the one mapped to "lora" in the
 * workflow inputs, or else the graph's only LoRA loader. Null when the graph
 * has none; "ambiguous" when it has several and none is mapped.
 */
export function loraLoader(workflow: SavedWorkflow): { nodeId: string; title: string } | null | "ambiguous" {
  const mapped = workflow.bindings.find((b) => b.target === "lora" && workflow.graph[b.nodeId]);
  if (mapped) return { nodeId: mapped.nodeId, title: nodeTitle(workflow.graph[mapped.nodeId]) };
  const loaders = Object.entries(workflow.graph).filter(([, n]) => LORA_LOADER.test(n.class_type));
  if (!loaders.length) return null;
  if (loaders.length > 1) return "ambiguous";
  return { nodeId: loaders[0][0], title: nodeTitle(loaders[0][1]) };
}

export interface WorkflowBinding {
  nodeId: string;
  input: string;
  /** A standard parameter, or "field" to show the raw input in the panel. */
  target: WorkflowParam | "field";
  /** Panel label for "field" bindings. */
  label?: string;
}

export interface SavedWorkflow {
  id: string;
  name: string;
  graph: ComfyWorkflow;
  bindings: WorkflowBinding[];
  createdAt: number;
  /**
   * Which version of input detection the bindings are from: absent for one
   * saved before 0.2.2, then a `BINDINGS_VERSION`. Upgrades run once, so a
   * mapping changed in the editor afterwards stays.
   */
  bindingsVersion?: number;
}

export type Primitive = string | number | boolean;

const isLink = (value: unknown): value is [string, number] =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number";

export const isPrimitive = (value: unknown): value is Primitive =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

export const nodeTitle = (node: ComfyNode) => node._meta?.title || node.class_type;

/** Key under which a "field" binding's value is kept in the form options. */
export const fieldKey = (binding: Pick<WorkflowBinding, "nodeId" | "input">) => `wf.${binding.nodeId}.${binding.input}`;

/** Accepts an API-format export; explains what to do with the editor format. */
export function parseWorkflowJson(text: string): ComfyWorkflow {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (data && typeof data === "object" && "nodes" in data && "links" in data) {
    throw new Error(
      "This is ComfyUI's editor format. In ComfyUI, use Workflow > Export (API) and import that file instead.",
    );
  }
  // Also accept a RunPod request body or a /prompt body.
  const obj = data as Record<string, unknown>;
  const candidate =
    (obj?.input as { workflow?: unknown } | undefined)?.workflow ??
    (obj?.prompt && typeof obj.prompt === "object" ? obj.prompt : undefined) ??
    obj;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("The file does not contain a ComfyUI workflow.");
  }
  const entries = Object.entries(candidate as Record<string, unknown>);
  const valid = entries.filter(
    ([, node]) => node && typeof node === "object" && typeof (node as ComfyNode).class_type === "string",
  );
  if (!valid.length || valid.length !== entries.length) {
    throw new Error("The file does not look like a ComfyUI API workflow (every node needs a class_type).");
  }
  const graph: ComfyWorkflow = {};
  for (const [id, node] of valid) {
    const n = node as ComfyNode;
    graph[id] = { class_type: n.class_type, inputs: n.inputs ?? {}, ...(n._meta ? { _meta: n._meta } : {}) };
  }
  return graph;
}

const TEXT_INPUT = /^(text|text_g|text_l|prompt|positive_prompt)$/;
const NEGATIVE_TEXT_INPUT = /^(negative_prompt|negative_text)$/;

/**
 * Follows a conditioning link upstream to the node holding the text. An
 * encoder that takes both prompts and gives both conditionings (such as
 * MOSSImageEditTextEncode) feeds each sampler branch from its own input: the
 * negative branch from `negative_prompt`, the positive one from `prompt`.
 */
function findTextSource(
  graph: ComfyWorkflow,
  link: unknown,
  branch: "positive" | "negative",
  depth = 0,
): { nodeId: string; inputs: string[] } | null {
  if (!isLink(link) || depth > 6) return null;
  const node = graph[link[0]];
  if (!node) return null;
  const strings = Object.keys(node.inputs).filter((k) => typeof node.inputs[k] === "string");
  const negatives = strings.filter((k) => NEGATIVE_TEXT_INPUT.test(k));
  const texts = strings.filter((k) => TEXT_INPUT.test(k));
  const inputs = branch === "negative" && negatives.length ? negatives : texts;
  if (inputs.length) return { nodeId: link[0], inputs };
  for (const key of ["conditioning", "conditioning_1", "positive", "cond"]) {
    const found = findTextSource(graph, node.inputs[key], branch, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * The reference number of a LoadImage node titled "Reference 1",
 * "Reference 2 — Person" and so on (1 to 4); null for any other title.
 */
export function referenceTitleNumber(node: ComfyNode): number | null {
  const match = /^\s*reference\s*([1-4])(?!\d)/i.exec(node._meta?.title ?? "");
  return match ? Number(match[1]) : null;
}

/** Titled as a reference at all, numbered 1 to 4 or not ("Reference 5", "Reference 0"). */
const hasReferenceTitle = (node: ComfyNode) => /^\s*reference\s*\d/i.test(node._meta?.title ?? "");

/**
 * Titles of LoadImage nodes named as a reference outside 1 to 4. They are
 * mapped to nothing, rather than taken for the input image, so the import can
 * say so.
 */
export function unsupportedReferenceTitles(graph: ComfyWorkflow): string[] {
  return Object.values(graph)
    .filter((node) => node.class_type === "LoadImage" && hasReferenceTitle(node) && !referenceTitleNumber(node))
    .map(nodeTitle);
}

/** Guesses which inputs the standard panel controls should drive. */
export function detectBindings(graph: ComfyWorkflow): WorkflowBinding[] {
  const bindings: WorkflowBinding[] = [];
  const taken = new Set<WorkflowParam>();
  const bind = (nodeId: string, input: string, target: WorkflowParam, allowRepeat = false) => {
    const value = graph[nodeId]?.inputs[input];
    if (!isPrimitive(value)) return;
    if (taken.has(target) && !allowRepeat) return;
    if (bindings.some((b) => b.nodeId === nodeId && b.input === input)) return;
    bindings.push({ nodeId, input, target });
    taken.add(target);
  };
  const byClass = (pattern: RegExp) =>
    Object.entries(graph)
      .filter(([, n]) => pattern.test(n.class_type))
      .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));

  // Samplers and the text that feeds them.
  for (const [id, node] of byClass(/^(KSampler|KSamplerAdvanced|SamplerCustom)$/)) {
    bind(id, "seed", "seed");
    bind(id, "noise_seed", "seed");
    bind(id, "steps", "steps");
    bind(id, "cfg", "cfg");
    bind(id, "sampler_name", "sampler");
    bind(id, "scheduler", "scheduler");
    bind(id, "denoise", "strength");
    // A negative branch that leads back to the prompt's own input is skipped,
    // since an input is only ever bound once.
    const positive = findTextSource(graph, node.inputs.positive, "positive");
    positive?.inputs.forEach((input) => bind(positive.nodeId, input, "prompt", true));
    const negative = findTextSource(graph, node.inputs.negative, "negative");
    negative?.inputs.forEach((input) => bind(negative.nodeId, input, "negativePrompt", true));
  }
  // Flux-style custom sampling pipeline.
  for (const [id] of byClass(/^RandomNoise$/)) bind(id, "noise_seed", "seed");
  for (const [id] of byClass(/^(BasicScheduler|Flux2Scheduler)$/)) {
    bind(id, "steps", "steps");
    bind(id, "scheduler", "scheduler");
    bind(id, "denoise", "strength");
  }
  for (const [id] of byClass(/^KSamplerSelect$/)) bind(id, "sampler_name", "sampler");
  for (const [id] of byClass(/^CFGGuider$/)) bind(id, "cfg", "cfg");
  for (const [id] of byClass(/^FluxGuidance$/)) bind(id, "guidance", "cfg");
  for (const [, node] of byClass(/^(BasicGuider|CFGGuider)$/)) {
    const positive = findTextSource(graph, node.inputs.conditioning ?? node.inputs.positive, "positive");
    positive?.inputs.forEach((input) => bind(positive.nodeId, input, "prompt", true));
    const negative = findTextSource(graph, node.inputs.negative, "negative");
    negative?.inputs.forEach((input) => bind(negative.nodeId, input, "negativePrompt", true));
  }
  // Last resort: the first text encoder is the prompt.
  if (!taken.has("prompt")) {
    for (const [id] of byClass(/^CLIPTextEncode/)) bind(id, "text", "prompt");
  }

  // Size and batch from the empty latent.
  for (const [id, node] of Object.entries(graph)) {
    const i = node.inputs;
    if (typeof i.width === "number" && typeof i.height === "number" && "batch_size" in i) {
      bind(id, "width", "width");
      bind(id, "height", "height");
      bind(id, "batch_size", "count");
    }
  }

  // Model loader.
  for (const [id] of byClass(/^(CheckpointLoaderSimple|CheckpointLoader|ImageOnlyCheckpointLoader)$/)) {
    bind(id, "ckpt_name", "model");
  }
  for (const [id] of byClass(/^(UNETLoader|UnetLoaderGGUF)$/)) bind(id, "unet_name", "model");

  // A single LoRA loader takes the LoRA chosen in the panel. With several,
  // which one is meant is the user's to map in the workflow inputs.
  const loras = byClass(LORA_LOADER);
  if (loras.length === 1) {
    bind(loras[0][0], "lora_name", "lora");
    bind(loras[0][0], "strength_model", "loraStrength");
  }

  // Reference images, by the number in the node's title, so the order holds
  // whatever the node ids. Only titled nodes: any other LoadImage may be the
  // input image or a fixed asset of the workflow. Every node with a number
  // gets that image, so a second loader for the same reference never keeps
  // the file it was saved with.
  const loaders = byClass(/^LoadImage$/);
  for (const [id, node] of loaders) {
    const n = referenceTitleNumber(node);
    if (n) bind(id, "image", REFERENCE_PARAMS[n - 1], true);
  }

  // Input image and mask.
  const masks = byClass(/^LoadImageMask$/);
  for (const [id] of masks) bind(id, "image", "mask");
  // Not a node titled as a reference, even one past Reference 4: taking it
  // for the input image would make the workflow image to image.
  for (const [id, node] of loaders) {
    if (!hasReferenceTitle(node)) bind(id, "image", "initImage");
  }

  return bindings;
}

/**
 * A saved workflow with its LoadImage nodes titled as references mapped as
 * importing it now would. Workflows saved before 0.2.1 may have one taken for
 * the input image (0.1.x took the lowest-numbered LoadImage, whatever its
 * title; 0.2.0 took one titled past Reference 4), and others left unmapped
 * (0.1.x left every other LoadImage; 0.2.0 a second loader of the same
 * number). Each of those is dropped from the input image, and every one
 * titled Reference 1 to 4 that maps to nothing is given its reference. A
 * mapping to anything else is left alone.
 *
 * 0.2.2's upgrade also mapped loaders whose image is wired from another
 * node, which a run would then replace with the upload, and saved them at
 * version 1 (0.2.3 stopped mapping them but kept the version, so it did not
 * undo them); a workflow below version 2 has any reference mapped to a
 * wired input dropped. The editor
 * only offers file names, so such a mapping was never the user's choice.
 *
 * Runs once per version: a workflow already at `BINDINGS_VERSION` is
 * returned as it is, so a mapping the user made in the editor since is never
 * undone. Any other comes back as a new object at that version, for the
 * caller to save.
 */
export function upgradeReferenceBindings(workflow: SavedWorkflow): SavedWorkflow {
  const version = workflow.bindingsVersion ?? 0;
  if (version >= BINDINGS_VERSION) return workflow;
  // Only a link: a binding to a node or input no longer in the graph is not
  // wired, and is left for the editor and the run checks as any other is.
  const wired = (b: WorkflowBinding) => referenceNumber(b.target) !== null && isLink(workflow.graph[b.nodeId]?.inputs[b.input]);
  let bindings = workflow.bindings.filter((b) => !wired(b));
  if (version < 1) bindings = mapReferenceLoaders(workflow.graph, bindings);
  return { ...workflow, bindings, bindingsVersion: BINDINGS_VERSION };
}

/** Version 1's upgrade: reference-titled loaders taken off the input image and mapped. */
function mapReferenceLoaders(graph: ComfyWorkflow, saved: WorkflowBinding[]): WorkflowBinding[] {
  const isReferenceLoader = (nodeId: string) => {
    const node = graph[nodeId];
    return node?.class_type === "LoadImage" && hasReferenceTitle(node);
  };
  const bindings = saved.filter((b) => !(b.target === "initImage" && b.input === "image" && isReferenceLoader(b.nodeId)));
  for (const [nodeId, node] of Object.entries(graph)) {
    const n = node.class_type === "LoadImage" ? referenceTitleNumber(node) : null;
    // As on import, only a file name can be replaced; an image wired in from
    // another node is left connected.
    if (!n || !isPrimitive(node.inputs.image)) continue;
    if (bindings.some((b) => b.nodeId === nodeId && b.input === "image")) continue;
    bindings.push({ nodeId, input: "image", target: REFERENCE_PARAMS[n - 1] });
  }
  return bindings;
}

/**
 * The workflow's reference inputs, numbered 1 up to the highest one mapped,
 * with the titles of the nodes each fills; an empty list for a number with no
 * input (a gap, such as Reference 1 and 3 mapped but not 2).
 */
export function workflowReferenceSlots(workflow: SavedWorkflow): { number: number; titles: string[] }[] {
  const slots: { number: number; titles: string[] }[] = [];
  for (const binding of workflow.bindings) {
    const n = referenceNumber(binding.target);
    const node = workflow.graph[binding.nodeId];
    if (!n || !node) continue;
    while (slots.length < n) slots.push({ number: slots.length + 1, titles: [] });
    slots[n - 1].titles.push(nodeTitle(node));
  }
  return slots;
}

/**
 * Why `count` attached references cannot run this workflow, or null when
 * they can: every mapped reference needs an image (the saved file name would
 * otherwise be loaded, a placeholder or a previous run's upload), and every
 * attached image needs an input to go to. A gap in the numbering (Reference 1
 * and 3 but not 2) fails both whatever is attached, so it is reported first,
 * as something to fix in the workflow rather than in the attachments.
 * `slots` can be passed in when the caller already has them.
 */
export function workflowReferenceProblem(
  workflow: SavedWorkflow,
  count: number,
  slots = workflowReferenceSlots(workflow),
): string | null {
  const gaps = slots.filter((s) => !s.titles.length).map((s) => s.number);
  if (gaps.length) {
    // Every missing number is needed, so they are joined with "and".
    const names = gaps.map((n) => `Reference ${n}`);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    const target = names.length > 1 ? `each of ${list}` : list;
    return `${workflow.name} maps Reference ${slots.length} but not ${list}, so it cannot run. In the workflow inputs, map a LoadImage node to ${target}, or number the references from 1 without gaps.`;
  }
  const missing = slots.filter((s) => s.titles.length && s.number > count);
  if (missing.length) {
    const names = missing.map((s) => s.titles[0]).join(", ");
    return `${workflow.name} needs ${slots.length} reference image${slots.length === 1 ? "" : "s"}. Attach ${missing.length === 1 ? "one" : "them"} for: ${names}.`;
  }
  const unmapped = Array.from({ length: count }, (_, i) => i + 1).filter((n) => !slots[n - 1]?.titles.length);
  if (unmapped.length) {
    const list = unmapped.join(", ");
    return `${workflow.name} has no input for reference image${unmapped.length === 1 ? "" : "s"} ${list}. Remove ${unmapped.length === 1 ? "it" : "them"}, or map a LoadImage node to Reference ${unmapped[0]} in the workflow inputs.`;
  }
  return null;
}

/**
 * The name a reference is uploaded under, from a hash of its bytes. Two
 * different images never share a name, whatever they were called, so neither
 * can stand in for the other or for a previous run's upload. The same image
 * always gets the same name, so a server that keeps an identical file it
 * already has (ComfyUI does, where its upload compares images) reuses one
 * file rather than gaining a copy each run; one that does not adds a renamed
 * copy instead, which is still this same image.
 */
export async function referenceUploadName(image: InputImage): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", image.bytes));
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  return `imagegen-ref-${hex}.${extForMime(image.mime)}`;
}

/**
 * Uploads the references under their content names, all at once, and returns
 * the names the server reports back in attachment order (which a workflow
 * must load, as the server may rename or file them in a subfolder). The same
 * image attached twice is sent once, so two uploads of it never race on the
 * server.
 */
export async function uploadReferences(
  references: InputImage[],
  upload: (image: InputImage, name: string) => Promise<string>,
): Promise<string[]> {
  const names = await Promise.all(references.map(referenceUploadName));
  const sent = new Map<string, Promise<string>>();
  return Promise.all(
    references.map((image, i) => {
      let uploaded = sent.get(names[i]);
      if (!uploaded) {
        uploaded = upload(image, names[i]);
        sent.set(names[i], uploaded);
      }
      return uploaded;
    }),
  );
}

/** What the parameter panel can offer for an imported workflow. */
export function workflowCapabilities(workflow: SavedWorkflow, base: Capabilities): Capabilities {
  const has = (param: WorkflowParam) => workflow.bindings.some((b) => b.target === param);
  const img2img = has("initImage");
  return {
    ...base,
    img2img,
    img2imgOnly: img2img,
    mask: img2img && has("mask"),
    negativePrompt: has("negativePrompt"),
    seed: has("seed"),
    steps: has("steps"),
    cfg: has("cfg"),
    sampler: has("sampler"),
    scheduler: has("scheduler"),
    strength: has("strength"),
    size: has("width") && has("height"),
    model: has("model"),
    maxCount: has("count") ? base.maxCount : 1,
    references: workflowReferenceSlots(workflow).length,
  };
}

function coerce(raw: string, original: unknown): Primitive {
  if (typeof original === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : original;
  }
  if (typeof original === "boolean") return raw === "true";
  return raw;
}

/**
 * A copy of the workflow's graph with the panel's values written in; the saved
 * graph is never changed. Throws when a mapped reference has no uploaded
 * image, rather than loading whatever file name the graph was saved with.
 */
export function applyWorkflow(
  workflow: SavedWorkflow,
  params: GenerateParams,
  refs: UploadedRefs = {},
): ComfyWorkflow {
  const graph: ComfyWorkflow = structuredClone(workflow.graph);
  const lora = params.lora ?? null;
  if (lora) {
    // A LoRA was chosen, so it must have somewhere to go: the graph is
    // never rewired to add a loader.
    const loader = loraLoader(workflow);
    if (!loader) {
      throw new Error(
        `${workflow.name} has no LoRA loader. Add a LoraLoaderModelOnly node between its model loader and sampler in ComfyUI, export the workflow again and re-import it, or choose no LoRA.`,
      );
    }
    if (loader === "ambiguous") {
      throw new Error(`${workflow.name} has several LoRA loaders. Map the one to use to "LoRA file" in the workflow inputs.`);
    }
    if (!workflow.bindings.some((b) => b.target === "lora")) {
      graph[loader.nodeId].inputs.lora_name = lora.name;
      graph[loader.nodeId].inputs.strength_model = lora.strength;
    }
  }
  for (const binding of workflow.bindings) {
    const node = graph[binding.nodeId];
    if (!node) continue;
    const current = node.inputs[binding.input];
    let value: unknown = current;
    switch (binding.target) {
      case "prompt":
        value = params.prompt;
        break;
      case "negativePrompt":
        value = params.negativePrompt;
        break;
      case "seed":
        value = params.seed;
        break;
      case "steps":
        value = params.steps || current;
        break;
      case "cfg":
        value = params.cfg;
        break;
      case "sampler":
        value = params.sampler || current;
        break;
      case "scheduler":
        value = params.scheduler || current;
        break;
      case "strength":
        // A text-to-image graph keeps its own denoise (normally 1).
        value = params.mode === "img2img" ? params.strength : current;
        break;
      case "width":
        value = params.width;
        break;
      case "height":
        value = params.height;
        break;
      case "count":
        value = params.count;
        break;
      case "model":
        value = params.model || current;
        break;
      case "lora":
        value = lora ? lora.name : current;
        break;
      case "loraStrength":
        value = lora ? lora.strength : current;
        break;
      case "initImage":
        value = refs.initImage ?? current;
        break;
      case "mask":
        value = refs.mask ?? current;
        break;
      case "reference1":
      case "reference2":
      case "reference3":
      case "reference4": {
        const n = referenceNumber(binding.target)!;
        const name = refs.references?.[n - 1];
        if (!name) throw new Error(`No image was uploaded for Reference ${n} (${nodeTitle(node)}).`);
        value = name;
        break;
      }
      case "field": {
        const raw = params.options[fieldKey(binding)];
        value = raw === undefined ? current : coerce(raw, current);
        break;
      }
    }
    node.inputs[binding.input] = value;
  }
  return graph;
}

/** Panel values taken from the workflow as exported, so it runs unchanged by default. */
export function workflowDefaults(workflow: SavedWorkflow) {
  const values: Partial<Record<WorkflowParam, Primitive>> = {};
  const options: Record<string, string> = {};
  for (const binding of workflow.bindings) {
    const value = workflow.graph[binding.nodeId]?.inputs[binding.input];
    if (!isPrimitive(value)) continue;
    if (binding.target === "field") options[fieldKey(binding)] = String(value);
    else values[binding.target] ??= value;
  }
  const num = (v: Primitive | undefined) => (typeof v === "number" ? v : undefined);
  const str = (v: Primitive | undefined) => (typeof v === "string" ? v : undefined);
  // A text-to-image graph's denoise (1.0) must not become the shared change amount.
  const takesImage = workflow.bindings.some((b) => b.target === "initImage");
  return {
    model: str(values.model),
    steps: num(values.steps),
    cfg: num(values.cfg),
    sampler: str(values.sampler),
    scheduler: str(values.scheduler),
    width: num(values.width),
    height: num(values.height),
    count: num(values.count),
    strength: takesImage ? num(values.strength) : undefined,
    options,
  };
}

/** The input a "model" binding points at, for listing its choices. */
export function boundInput(workflow: SavedWorkflow, target: WorkflowParam) {
  const binding = workflow.bindings.find((b) => b.target === target);
  const node = binding && workflow.graph[binding.nodeId];
  return binding && node ? { classType: node.class_type, input: binding.input } : null;
}

/** Every primitive input, grouped by node, for the binding editor. */
export function editableInputs(graph: ComfyWorkflow) {
  return Object.entries(graph)
    .sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b))
    .map(([nodeId, node]) => ({
      nodeId,
      node,
      inputs: Object.entries(node.inputs)
        .filter(([, value]) => isPrimitive(value))
        .map(([input, value]) => ({ input, value: value as Primitive })),
    }))
    .filter((group) => group.inputs.length > 0);
}
