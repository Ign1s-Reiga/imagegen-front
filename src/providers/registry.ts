import { a1111 } from "./a1111";
import { comfyui } from "./comfyui";
import { fal } from "./fal";
import { openai } from "./openai";
import { replicate } from "./replicate";
import { runpod } from "./runpod";
import type { ProviderDefinition, ProviderKind } from "./types";

/** Adding a backend: write a ProviderDefinition and list it here. */
export const PROVIDERS: Record<ProviderKind, ProviderDefinition> = {
  openai,
  comfyui,
  runpod,
  fal,
  replicate,
  a1111,
};

export const PROVIDER_ORDER: ProviderKind[] = ["openai", "comfyui", "runpod", "fal", "replicate", "a1111"];

export function provider(kind: ProviderKind): ProviderDefinition {
  return PROVIDERS[kind];
}

/** "Studio PC (ComfyUI)", or just "ComfyUI" when the name already says it. */
export function connectionLabel(name: string, kind: ProviderKind): string {
  const label = PROVIDERS[kind].label;
  return name === label ? name : `${name} (${label})`;
}
