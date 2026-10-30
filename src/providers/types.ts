import type { Bytes } from "@/lib/bytes";

import type { SavedWorkflow } from "./comfy-workflow";

export type ProviderKind = "openai" | "comfyui" | "runpod" | "fal" | "replicate" | "a1111";

export type Mode = "txt2img" | "img2img";

export interface InputImage {
  bytes: Bytes;
  mime: string;
  name: string;
  width: number;
  height: number;
}

/** Provider-neutral generation request. Each adapter maps what it supports. */
export interface GenerateParams {
  mode: Mode;
  prompt: string;
  negativePrompt: string;
  model: string;
  width: number;
  height: number;
  count: number;
  /** Resolved before the call: random seeds are picked by the caller. */
  seed: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  /** img2img denoise strength, 0..1. */
  strength: number;
  initImage: InputImage | null;
  /** Grayscale PNG at the input image's size: white marks the area to change. */
  mask: InputImage | null;
  /** Values for the provider's own `options` fields, keyed by field key. */
  options: Record<string, string>;
  /** Imported ComfyUI workflow to run instead of the built-in graph. */
  workflow?: SavedWorkflow | null;
}

export interface GeneratedImage {
  bytes: Bytes;
  mime: string;
  seed?: number | null;
}

export interface GenerateResult {
  images: GeneratedImage[];
  /** Model actually used, when the provider reports it. */
  model?: string;
  info?: Record<string, unknown>;
}

export interface Progress {
  stage: "uploading" | "queued" | "running" | "downloading";
  /** 0..1, or undefined when the provider gives no measurable progress. */
  fraction?: number;
  message?: string;
  /** Object URL of an in-progress preview. */
  preview?: string;
}

export interface RunContext {
  signal: AbortSignal;
  onProgress: (progress: Progress) => void;
}

export type ConnectionConfig = Record<string, string>;

export interface ConfigField {
  key: string;
  label: string;
  /** `secret` values are stored in the OS keychain, never in settings. */
  type: "text" | "url" | "secret";
  placeholder?: string;
  help?: string;
  required?: boolean;
  default?: string;
}

/** Extra generation options a provider shows in the parameter panel. */
export interface OptionField {
  key: string;
  label: string;
  type: "select" | "text" | "number" | "json";
  options?: { value: string; label: string }[];
  default: string;
  help?: string;
  /** Only show in this mode. */
  mode?: Mode;
}

export interface Capabilities {
  img2img: boolean;
  /** The graph needs an input image, so text to image is not offered. */
  img2imgOnly?: boolean;
  mask: boolean;
  negativePrompt: boolean;
  seed: boolean;
  steps: boolean;
  cfg: boolean;
  sampler: boolean;
  scheduler: boolean;
  strength: boolean;
  /** Width and height can be set. */
  size: boolean;
  /** A model can be chosen. */
  model: boolean;
  maxCount: number;
  /** Width/height must be a multiple of this. */
  sizeStep: number;
}

export interface ModelChoice {
  value: string;
  label?: string;
}

export interface ProviderDefinition {
  kind: ProviderKind;
  label: string;
  /** One line shown when choosing a provider. */
  summary: string;
  fields: ConfigField[];
  options: OptionField[];
  capabilities: (config: ConnectionConfig, workflow?: SavedWorkflow | null) => Capabilities;
  /** Can run imported ComfyUI workflows. */
  supportsWorkflows?: boolean;
  /** Model used when the parameter panel leaves the model empty. */
  defaultModel: (config: ConnectionConfig) => string;
  /** Static model suggestions; `listModels` replaces them when available. */
  suggestedModels: string[];
  defaults?: Partial<Pick<GenerateParams, "steps" | "cfg" | "sampler" | "scheduler">>;
  listModels?: (config: ConnectionConfig, signal?: AbortSignal) => Promise<ModelChoice[]>;
  listSamplers?: (
    config: ConnectionConfig,
    signal?: AbortSignal,
  ) => Promise<{ samplers: string[]; schedulers: string[] }>;
  /** Choices for combo inputs, keyed "ClassType.input" (ComfyUI /object_info). */
  listInputChoices?: (
    config: ConnectionConfig,
    inputs: { classType: string; input: string }[],
    signal?: AbortSignal,
  ) => Promise<Record<string, string[]>>;
  /** Resolves with a short human-readable status, rejects with the problem. */
  testConnection: (config: ConnectionConfig, signal?: AbortSignal) => Promise<string>;
  generate: (params: GenerateParams, config: ConnectionConfig, ctx: RunContext) => Promise<GenerateResult>;
}

/** Saved connection. Secret fields are held in the keychain, not here. */
export interface Connection {
  id: string;
  kind: ProviderKind;
  name: string;
  config: ConnectionConfig;
}
