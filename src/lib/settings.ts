import { load, type Store } from "@tauri-apps/plugin-store";

import type { SavedWorkflow } from "@/providers/comfy-workflow";
import type { Connection } from "@/providers/types";

export interface PersistedForm {
  prompt: string;
  negativePrompt: string;
  model: string;
  width: number;
  height: number;
  count: number;
  seed: number | null;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  strength: number;
  options: Record<string, string>;
}

/** The chat model behind the prompt helper and the pixel assistant. */
export interface AssistantChoice {
  connectionId: string;
  model: string;
}

export interface Settings {
  connections: Connection[];
  activeConnectionId: string | null;
  /** Last-used form per connection, so switching backends keeps each one's setup. */
  forms: Record<string, Partial<PersistedForm>>;
  /** Imported ComfyUI workflows, shared by ComfyUI and RunPod connections. */
  workflows: SavedWorkflow[];
  assistant: AssistantChoice | null;
}

const DEFAULTS: Settings = { connections: [], activeConnectionId: null, forms: {}, workflows: [], assistant: null };

let storePromise: Promise<Store> | null = null;

const store = () =>
  (storePromise ??= load("settings.json", {
    defaults: DEFAULTS as unknown as Record<string, unknown>,
    autoSave: 400,
  }));

export async function loadSettings(): Promise<Settings> {
  const s = await store();
  return {
    connections: (await s.get<Connection[]>("connections")) ?? [],
    activeConnectionId: (await s.get<string | null>("activeConnectionId")) ?? null,
    forms: (await s.get<Settings["forms"]>("forms")) ?? {},
    workflows: (await s.get<SavedWorkflow[]>("workflows")) ?? [],
    assistant: (await s.get<AssistantChoice | null>("assistant")) ?? null,
  };
}

export async function saveSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await (await store()).set(key, value);
}
