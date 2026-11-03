import type { Bytes } from "@/lib/bytes";

import type { ChatService } from "./chat";
import type { LoraChoice, SavedWorkflow } from "./comfy-workflow";

/** Image backends: services that generate images. */
export type ProviderKind = "openai" | "openrouter" | "comfyui" | "runpod" | "fal" | "replicate" | "a1111";

/** Every kind of saved connection: the image backends plus chat-only services. */
export type ConnectionKind = ProviderKind | "anthropic" | "gpuhost";

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
  /** Images that guide the result (a character, a style, a product), in the order given. */
  references: InputImage[];
  /** Values for the provider's own `options` fields, keyed by field key. */
  options: Record<string, string>;
  /** Imported ComfyUI workflow to run instead of the built-in graph. */
  workflow?: SavedWorkflow | null;
  /** A LoRA for the workflow's LoRA loader; null keeps the workflow's own. */
  lora?: LoraChoice | null;
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
  /** Things the user should know about a run that still succeeded, such as a setting the model ignored. */
  notices?: string[];
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
  /** Edited in a text area (a pasted key). */
  multiline?: boolean;
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
  /** Only show for models that take it, as `ProviderDefinition.modelOptionKeys` reports. */
  perModel?: boolean;
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
  /** Reference images a generation can take; 0 when the backend cannot use them. */
  references: number;
  /** Width/height must be a multiple of this. */
  sizeStep: number;
}

export interface ModelChoice {
  value: string;
  label?: string;
}

/** What every connection kind declares: how it is set up, checked and billed. */
export interface ServiceDefinition {
  kind: ConnectionKind;
  label: string;
  /** One line shown when choosing a provider. */
  summary: string;
  fields: ConfigField[];
  /** Resolves with a short human-readable status, rejects with the problem. */
  testConnection: (config: ConnectionConfig, signal?: AbortSignal) => Promise<string>;
  /**
   * Account credit or spend. Resolves null when this connection is not set
   * up to read it (e.g. no OpenAI admin key).
   */
  getCredit?: (config: ConnectionConfig, signal?: AbortSignal) => Promise<CreditInfo | null>;
  /** Chat models, for the prompt helper and the pixel assistant. */
  chat?: ChatService;
  /** Records a host key the user approved by fingerprint (SSH connections). */
  trustHostKey?: (config: ConnectionConfig, fingerprint: string) => Promise<void>;
}

/** An image backend. */
export interface ProviderDefinition extends ServiceDefinition {
  kind: ProviderKind;
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
  /** Which `perModel` options a model takes, by key. Rejects, with the HTTP error where there is one, when they cannot be read. */
  modelOptionKeys?: (config: ConnectionConfig, model: string, signal?: AbortSignal) => Promise<string[]>;
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
  generate: (params: GenerateParams, config: ConnectionConfig, ctx: RunContext) => Promise<GenerateResult>;
}

export interface Money {
  amount: number;
  /** ISO 4217 code, upper case. */
  currency: string;
}

export interface CreditInfo {
  /** Prepaid balance left. */
  balance?: Money;
  /** Spend since the start of the current month (UTC). */
  monthSpend?: Money;
  /** Current burn rate, e.g. running RunPod workers. */
  spendPerHour?: Money;
  /** Maximum spend per hour the account allows. */
  spendLimitPerHour?: Money;
  /** The provider says the balance is low or exhausted. */
  low?: boolean;
}

/** Saved connection. Secret fields are held in the keychain, not here. */
export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  config: ConnectionConfig;
}

/** A connection to an image backend. */
export type ImageConnection = Connection & { kind: ProviderKind };
