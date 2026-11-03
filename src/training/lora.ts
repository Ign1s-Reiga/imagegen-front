// Which trained LoRAs can go where. A LoRA loads only into the model family
// it was trained on; a ComfyUI workflow says its family by the model file its
// loader loads, and anything that cannot be read that way is not assumed to
// match.

import { isPrimitive, loraLoader, type LoraChoice, type SavedWorkflow } from "../providers/comfy-workflow.ts";
import type { ProviderKind } from "../providers/types";

import { family } from "./trainers.ts";

export interface TrainedLora {
  id: string;
  family: string;
  baseModel: string;
  triggerToken: string;
  step: number;
  /** Where it is installed: the file name ComfyUI lists, per host. */
  installs?: { hostId: string; hostLabel: string; dir: string; fileName: string; at: number }[];
}

/** The model files the workflow's loaders load, with `model` standing in for a mapped loader. */
export function workflowModelFiles(workflow: SavedWorkflow, model: string): string[] {
  const files: string[] = [];
  const mapped = new Set(workflow.bindings.filter((b) => b.target === "model").map((b) => `${b.nodeId}.${b.input}`));
  for (const [id, node] of Object.entries(workflow.graph)) {
    if (!/^(UNETLoader|UnetLoaderGGUF|CheckpointLoaderSimple|CheckpointLoader|ImageOnlyCheckpointLoader)$/.test(node.class_type)) continue;
    for (const input of ["unet_name", "ckpt_name"]) {
      const value = node.inputs[input];
      if (!isPrimitive(value)) continue;
      files.push(mapped.has(`${id}.${input}`) && model ? model : String(value));
    }
  }
  return files;
}

/** The family a workflow runs, when its model files say so unambiguously. */
export function workflowFamily(workflow: SavedWorkflow, model: string, familyIds: string[]): string | null {
  const files = workflowModelFiles(workflow, model);
  const found = familyIds.filter((id) => {
    const f = family(id);
    return f && files.some((file) => f.comfyModelFiles.some((pattern) => pattern.test(file)));
  });
  return found.length === 1 ? found[0] : null;
}

export type LoraFit =
  | { ok: true; loaderTitle: string }
  | { ok: false; reason: string };

/** Whether a trained LoRA can be used with this backend and workflow, and why not. */
export function loraFit(
  lora: TrainedLora,
  kind: ProviderKind | null,
  workflow: SavedWorkflow | null,
  model: string,
): LoraFit {
  const familyLabel = family(lora.family)?.label ?? lora.family;
  if (kind !== "comfyui") {
    return {
      ok: false,
      reason:
        kind === "runpod"
          ? "RunPod serverless workers load only the models baked into their image, so a LoRA trained here cannot be attached. Use a ComfyUI connection to the host it is installed on."
          : "This backend cannot load a LoRA file trained here. Choose a ComfyUI connection.",
    };
  }
  if (!workflow) {
    return { ok: false, reason: `Choose an imported ${familyLabel} workflow with a LoRA loader. The built-in graph is a checkpoint workflow and has none.` };
  }
  const loader = loraLoader(workflow);
  if (!loader) {
    return {
      ok: false,
      reason: `${workflow.name} has no LoRA loader. Add a LoraLoaderModelOnly node after its model loader in ComfyUI, then export and re-import the workflow. It is not added automatically.`,
    };
  }
  if (loader === "ambiguous") {
    return { ok: false, reason: `${workflow.name} has several LoRA loaders. Map the one to use to "LoRA file" in the workflow inputs.` };
  }
  const runs = workflowFamily(workflow, model, [lora.family]);
  if (runs !== lora.family) {
    const files = workflowModelFiles(workflow, model);
    return {
      ok: false,
      reason: `This LoRA is for ${familyLabel}, but ${workflow.name} loads ${files.length ? files.join(", ") : "no model file this app can identify"}. LoRAs are not interchangeable between model families.`,
    };
  }
  return { ok: true, loaderTitle: loader.title };
}

/** The prompt with the trigger token added once, at the front. */
export function withTrigger(prompt: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escaped}\\b`, "i").test(prompt)) return prompt;
  const rest = prompt.trim();
  return rest ? `photo of ${token} person, ${rest}` : `photo of ${token} person`;
}

/** Form option keys the chosen LoRA is kept under, per connection. */
export const LORA_OPTIONS = { meta: "lora.meta", file: "lora.file", strength: "lora.strength" } as const;

/** The LoRA a run uses, from the form's options; null when none is chosen. */
export function loraChoice(options: Record<string, string>): LoraChoice | null {
  const name = options[LORA_OPTIONS.file]?.trim();
  if (!name) return null;
  const strength = Number(options[LORA_OPTIONS.strength]);
  return { name, strength: Number.isFinite(strength) ? strength : 1 };
}

/** What the chosen LoRA was trained as, when it is one of the app's own. */
export function trainedLoraMeta(options: Record<string, string>): TrainedLora | null {
  const raw = options[LORA_OPTIONS.meta];
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as TrainedLora;
    return typeof meta.family === "string" && typeof meta.id === "string" ? meta : null;
  } catch {
    return null;
  }
}

/** Options that select a trained LoRA at a strength. */
export function loraOptions(lora: TrainedLora, fileName: string, strength: number): Record<string, string> {
  const meta: TrainedLora = { id: lora.id, family: lora.family, baseModel: lora.baseModel, triggerToken: lora.triggerToken, step: lora.step };
  return { [LORA_OPTIONS.meta]: JSON.stringify(meta), [LORA_OPTIONS.file]: fileName, [LORA_OPTIONS.strength]: String(strength) };
}

/** The options with no LoRA chosen. */
export function withoutLora(options: Record<string, string>): Record<string, string> {
  const rest = { ...options };
  for (const key of Object.values(LORA_OPTIONS)) delete rest[key];
  return rest;
}
