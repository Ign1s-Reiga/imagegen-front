import { a1111 } from "./a1111";
import { anthropic } from "./anthropic";
import type { ChatService } from "./chat";
import { comfyui } from "./comfyui";
import { fal } from "./fal";
import { openai } from "./openai";
import { openrouter } from "./openrouter";
import { replicate } from "./replicate";
import { runpod } from "./runpod";
import type {
  Connection,
  ConnectionKind,
  ImageConnection,
  ProviderDefinition,
  ProviderKind,
  ServiceDefinition,
} from "./types";

/** Adding a backend: write a ProviderDefinition and list it here. */
export const PROVIDERS: Record<ProviderKind, ProviderDefinition> = {
  openai,
  openrouter,
  comfyui,
  runpod,
  fal,
  replicate,
  a1111,
};

/** Every connection kind, image backends first; the order of the "Add a connection" list. */
export const SERVICES: Record<ConnectionKind, ServiceDefinition> = { ...PROVIDERS, anthropic };

export const SERVICE_ORDER: ConnectionKind[] = [
  "openai",
  "openrouter",
  "comfyui",
  "runpod",
  "fal",
  "replicate",
  "a1111",
  "anthropic",
];

export function provider(kind: ProviderKind): ProviderDefinition {
  return PROVIDERS[kind];
}

export function service(kind: ConnectionKind): ServiceDefinition {
  return SERVICES[kind];
}

export const isImageKind = (kind: ConnectionKind): kind is ProviderKind => kind in PROVIDERS;

export const isImageConnection = (connection: Connection): connection is ImageConnection => isImageKind(connection.kind);

/** The chat models a connection offers, if any (Claude, OpenRouter). */
export const chatService = (connection: Connection): ChatService | null => service(connection.kind).chat ?? null;

/** "Studio PC (ComfyUI)", or just "ComfyUI" when the name already says it. */
export function connectionLabel(name: string, kind: ConnectionKind): string {
  const label = SERVICES[kind].label;
  return name === label ? name : `${name} (${label})`;
}
