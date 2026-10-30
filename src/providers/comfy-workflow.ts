import type { Capabilities, GenerateParams } from "./types";

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title: string };
}

export type ComfyWorkflow = Record<string, ComfyNode>;

export const SAVE_NODE_ID = "9";

/** File names a generation uploaded to Comfy's input folder. */
export interface UploadedRefs {
  initImage?: string;
  mask?: string;
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
  | "mask";

export const WORKFLOW_PARAMS: { value: WorkflowParam; label: string; kind: "string" | "number" }[] = [
  { value: "prompt", label: "Prompt", kind: "string" },
  { value: "negativePrompt", label: "Avoid (negative prompt)", kind: "string" },
  { value: "model", label: "Model", kind: "string" },
  { value: "initImage", label: "Input image", kind: "string" },
  { value: "mask", label: "Mask", kind: "string" },
  { value: "sampler", label: "Sampler", kind: "string" },
  { value: "scheduler", label: "Scheduler", kind: "string" },
  { value: "seed", label: "Seed", kind: "number" },
  { value: "steps", label: "Steps", kind: "number" },
  { value: "cfg", label: "Guidance", kind: "number" },
  { value: "strength", label: "Change amount (denoise)", kind: "number" },
  { value: "width", label: "Width", kind: "number" },
  { value: "height", label: "Height", kind: "number" },
  { value: "count", label: "Images (batch size)", kind: "number" },
];

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

/** Follows a conditioning link upstream to the node holding the text. */
function findTextSource(graph: ComfyWorkflow, link: unknown, depth = 0): { nodeId: string; inputs: string[] } | null {
  if (!isLink(link) || depth > 6) return null;
  const node = graph[link[0]];
  if (!node) return null;
  const textInputs = Object.keys(node.inputs).filter(
    (k) => typeof node.inputs[k] === "string" && /^(text|text_g|text_l|prompt)$/.test(k),
  );
  if (textInputs.length) return { nodeId: link[0], inputs: textInputs };
  for (const key of ["conditioning", "conditioning_1", "positive", "cond"]) {
    const found = findTextSource(graph, node.inputs[key], depth + 1);
    if (found) return found;
  }
  return null;
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
    const positive = findTextSource(graph, node.inputs.positive);
    positive?.inputs.forEach((input) => bind(positive.nodeId, input, "prompt", true));
    const negative = findTextSource(graph, node.inputs.negative);
    if (negative && negative.nodeId !== positive?.nodeId) {
      negative.inputs.forEach((input) => bind(negative.nodeId, input, "negativePrompt", true));
    }
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
    const positive = findTextSource(graph, node.inputs.conditioning ?? node.inputs.positive);
    positive?.inputs.forEach((input) => bind(positive.nodeId, input, "prompt", true));
    const negative = findTextSource(graph, node.inputs.negative);
    if (negative && negative.nodeId !== positive?.nodeId) {
      negative.inputs.forEach((input) => bind(negative.nodeId, input, "negativePrompt", true));
    }
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

  // Input image and mask.
  const masks = byClass(/^LoadImageMask$/);
  for (const [id] of masks) bind(id, "image", "mask");
  for (const [id] of byClass(/^LoadImage$/)) bind(id, "image", "initImage");

  return bindings;
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

/** A copy of the workflow's graph with the panel's values written in. */
export function applyWorkflow(
  workflow: SavedWorkflow,
  params: GenerateParams,
  refs: UploadedRefs = {},
): ComfyWorkflow {
  const graph: ComfyWorkflow = structuredClone(workflow.graph);
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
      case "initImage":
        value = refs.initImage ?? current;
        break;
      case "mask":
        value = refs.mask ?? current;
        break;
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
