// Trainers and the model families they train. One is implemented: the
// Diffusers DreamBooth LoRA script for Qwen-Image 2.1. The adapter says what
// it supports, checks settings and derives what they mean; the transport
// (upload, start, status, cancel) is the same runner protocol for every
// trainer, behind the Rust commands in api.ts.

export interface TrainingConfig {
  resolution: number;
  /** Aspect-ratio buckets instead of one square crop. */
  buckets: boolean;
  rank: number;
  alpha: number;
  learningRate: number;
  batchSize: number;
  gradAccum: number;
  maxSteps: number;
  seed: number;
  precision: "bf16" | "fp16" | "no";
  use8bitAdam: boolean;
  gradientCheckpointing: boolean;
  cacheLatents: boolean;
  offload: boolean;
  quantize4bit: boolean;
  lrScheduler: "constant" | "constant_with_warmup" | "linear" | "cosine";
  warmupSteps: number;
  checkpointSteps: number;
  randomFlip: boolean;
  captionDropout: number;
  loraLayers?: string | null;
  validationPrompts: string[];
  validationSeeds: number[];
  /** Validate every this many steps; a multiple of the checkpoint interval. */
  validationEvery: number;
  /** Sampling steps per validation image. */
  validationSteps: number;
  /** Also generate the prompts without the LoRA, for comparison. */
  validationIncludeBase: boolean;
}

export interface ModelFamily {
  id: string;
  label: string;
  /** Base models this family's LoRAs are trained on and load into. */
  baseModels: { repo: string; label: string }[];
  /**
   * How a ComfyUI workflow shows it runs this family: patterns for the file
   * its model loader loads. Anything else is not assumed compatible.
   */
  comfyModelFiles: RegExp[];
}

export interface Issue {
  field?: keyof TrainingConfig;
  message: string;
  /** Blocks starting a run; warnings only inform. */
  blocking: boolean;
}

export interface Derived {
  effectiveBatch: number;
  optimizerSteps: number;
  /** Images seen in training: optimizer steps times effective batch. */
  samplesSeen: number;
  /** How many times each included photo is seen, on average. */
  epochs: number | null;
  checkpoints: number;
  validationPoints: number;
  validationImages: number;
}

export interface TrainerAdapter {
  id: string;
  label: string;
  version: string;
  /** Where the preset and limits come from. */
  source: string;
  families: ModelFamily[];
  preset: (family: string, triggerToken: string) => TrainingConfig;
  /** Explains each choice in the preset, for the summary. */
  presetNotes: string[];
  validate: (config: TrainingConfig, datasetSize: number) => Issue[];
}

export const QWEN_IMAGE_21: ModelFamily = {
  id: "qwen-image-2.1",
  label: "Qwen-Image 2.1",
  baseModels: [{ repo: "Qwen/Qwen-Image-2.1", label: "Qwen-Image 2.1 (base)" }],
  comfyModelFiles: [/qwen[_\- ]?image[_\- ]?2[._]1(?![._]?\d)(?!.*turbo)/i],
};

/** Families and checkpoints people may expect to train here, and why they cannot. */
export const UNSUPPORTED: { label: string; reason: string }[] = [
  {
    label: "Qwen-Image 2.1 Turbo",
    reason: "The Diffusers script documents only the base model. A Turbo checkpoint samples a fixed few-step schedule, so a LoRA trained on the base model may behave differently on it.",
  },
  { label: "Qwen-Image (1.x)", reason: "A different transformer. Its LoRAs do not load into Qwen-Image 2.1, nor the other way round." },
  { label: "MOSS", reason: "No trainer is implemented for it here." },
  { label: "FLUX, SDXL and SD 1.5", reason: "No trainer is implemented for them here, and their LoRAs are not interchangeable with Qwen-Image LoRAs." },
];

/**
 * The upstream example's settings (examples/dreambooth/README_qwenimage21.md
 * in Diffusers v0.42.1), with three changes for photographs of a person,
 * each from the script's own documented options: rank and alpha at the
 * script's defaults (16/16, scale 1, as the README's rank section advises
 * over the 4/4 of the dog example), aspect-ratio buckets so full-body
 * photos are not cropped to a square, and caching latents and gradient
 * checkpointing, the documented memory savers.
 */
function qwenPreset(_family: string, trigger: string): TrainingConfig {
  return {
    resolution: 1024,
    buckets: true,
    rank: 16,
    alpha: 16,
    learningRate: 1e-4,
    batchSize: 1,
    gradAccum: 4,
    maxSteps: 500,
    seed: 0,
    precision: "bf16",
    use8bitAdam: true,
    gradientCheckpointing: true,
    cacheLatents: true,
    offload: false,
    quantize4bit: false,
    lrScheduler: "constant",
    warmupSteps: 0,
    checkpointSteps: 100,
    randomFlip: false,
    captionDropout: 0,
    loraLayers: null,
    validationPrompts: [
      `photo of ${trigger} person, head and shoulders portrait, neutral background, soft daylight`,
      `photo of ${trigger} person standing in a park, full body, casual clothes`,
    ],
    validationSeeds: [1234, 5678],
    validationEvery: 100,
    validationSteps: 40,
    validationIncludeBase: true,
  };
}

const isWhole = (n: number) => Number.isInteger(n);

function validateQwen(c: TrainingConfig, datasetSize: number): Issue[] {
  const issues: Issue[] = [];
  const block = (field: keyof TrainingConfig, message: string) => issues.push({ field, message, blocking: true });
  const warn = (field: keyof TrainingConfig | undefined, message: string) => issues.push({ field, message, blocking: false });
  const range = (field: keyof TrainingConfig, value: number, lo: number, hi: number, label: string) => {
    if (!Number.isFinite(value) || value < lo || value > hi) block(field, `${label} must be between ${lo} and ${hi}.`);
  };

  range("resolution", c.resolution, 256, 2048, "Resolution");
  if (c.resolution % 32) block("resolution", "Qwen-Image 2.1 needs a resolution that is a multiple of 32.");
  range("rank", c.rank, 1, 256, "Rank");
  range("alpha", c.alpha, 1, 512, "Alpha");
  if (!isWhole(c.rank) || !isWhole(c.alpha)) block("rank", "Rank and alpha are whole numbers.");
  range("learningRate", c.learningRate, 1e-7, 1e-2, "Learning rate");
  range("batchSize", c.batchSize, 1, 16, "Batch size");
  range("gradAccum", c.gradAccum, 1, 64, "Gradient accumulation");
  range("maxSteps", c.maxSteps, 1, 100_000, "Steps");
  range("checkpointSteps", c.checkpointSteps, 1, Math.max(1, c.maxSteps), "The checkpoint interval");
  range("seed", c.seed, 0, 2 ** 31 - 1, "Seed");
  range("captionDropout", c.captionDropout, 0, 1, "Caption dropout");
  range("validationSteps", c.validationSteps, 1, 100, "Validation sampling steps");
  if (c.validationEvery <= 0 || c.validationEvery % c.checkpointSteps) {
    block("validationEvery", "Validate at a multiple of the checkpoint interval, since validation uses saved checkpoints.");
  }
  if (c.validationPrompts.length > 8 || c.validationPrompts.some((p) => !p.trim())) {
    block("validationPrompts", "Use up to 8 non-empty validation prompts.");
  }
  if (!c.validationSeeds.length || c.validationSeeds.length > 4) block("validationSeeds", "Use 1 to 4 validation seeds.");
  if (c.loraLayers && !/^[A-Za-z0-9_.]+(,[A-Za-z0-9_.]+)*$/.test(c.loraLayers)) {
    block("loraLayers", "LoRA layers must be a comma-separated list of module names.");
  }

  if (c.alpha !== c.rank) {
    warn("alpha", `Alpha ${c.alpha} with rank ${c.rank} scales the LoRA by ${(c.alpha / c.rank).toFixed(2)}. The upstream README advises raising both together unless you mean to change its strength.`);
  }
  if (c.quantize4bit && c.precision !== "bf16") warn("quantize4bit", "The upstream example quantizes with bf16 mixed precision.");
  if (c.randomFlip) warn("randomFlip", "Mirroring photos also mirrors asymmetric features (a parting, a mole), which can blur likeness.");
  if (!c.buckets) warn("buckets", "Without buckets every photo is cropped to a square, which cuts the body from full-length shots.");
  if (!c.validationPrompts.length) warn("validationPrompts", "Without validation prompts there are no images to compare checkpoints by.");
  if (datasetSize === 0) issues.push({ message: "Include at least one photo.", blocking: true });
  return issues;
}

export const DIFFUSERS_QWEN_IMAGE_21: TrainerAdapter = {
  id: "diffusers-qwenimage21",
  label: "Diffusers DreamBooth LoRA",
  version: "diffusers 0.42.1 (train_dreambooth_lora_qwenimage21.py, pinned by hash)",
  source: "https://github.com/huggingface/diffusers/blob/v0.42.1/examples/dreambooth/README_qwenimage21.md",
  families: [QWEN_IMAGE_21],
  preset: qwenPreset,
  presetNotes: [
    "Learning rate 1e-4, batch 1 with 4 accumulation steps, 500 steps, constant schedule, 8-bit Adam, bf16: the upstream example.",
    "Rank and alpha 16: the script's defaults, applied at full strength (alpha / rank = 1).",
    "Aspect-ratio buckets, so portrait and full-body photos keep their framing.",
    "Cached latents and gradient checkpointing: the documented memory savers.",
    "A checkpoint every 100 steps, each validated with fixed prompts and seeds, so you can choose by the images rather than the loss.",
  ],
  validate: validateQwen,
};

export const TRAINERS: TrainerAdapter[] = [DIFFUSERS_QWEN_IMAGE_21];

export const trainer = (id: string) => TRAINERS.find((t) => t.id === id) ?? null;

export const family = (id: string) => TRAINERS.flatMap((t) => t.families).find((f) => f.id === id) ?? null;

export function derive(c: TrainingConfig, datasetSize: number): Derived {
  const effectiveBatch = c.batchSize * c.gradAccum;
  const samplesSeen = c.maxSteps * effectiveBatch;
  const checkpoints = Math.floor(c.maxSteps / c.checkpointSteps) + (c.maxSteps % c.checkpointSteps ? 1 : 0);
  // Validation covers each multiple of the interval and the last step.
  const points = new Set<number>();
  for (let s = c.checkpointSteps; s <= c.maxSteps; s += c.checkpointSteps) if (s % c.validationEvery === 0) points.add(s);
  points.add(c.maxSteps);
  const validationPoints = c.validationPrompts.length ? points.size + (c.validationIncludeBase ? 1 : 0) : 0;
  return {
    effectiveBatch,
    optimizerSteps: c.maxSteps,
    samplesSeen,
    epochs: datasetSize ? samplesSeen / datasetSize : null,
    checkpoints,
    validationPoints,
    validationImages: validationPoints * c.validationPrompts.length * c.validationSeeds.length,
  };
}

export const hasBlocking = (issues: Issue[]) => issues.some((i) => i.blocking);

/** A ready-to-use trigger token suggestion: a rare-looking lowercase word. */
export function suggestToken(name: string, taken: string[]): string {
  const letters = name.toLowerCase().replace(/[^a-z]/g, "").slice(0, 3) || "sbj";
  for (let i = 0; i < 100; i++) {
    const token = `${letters}${"xzq"[i % 3]}${i ? i : ""}`.slice(0, 24);
    if (!taken.includes(token) && token.length >= 3) return token;
  }
  return `tok${Date.now() % 100000}`;
}

export const TOKEN_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{3,24}$/;
