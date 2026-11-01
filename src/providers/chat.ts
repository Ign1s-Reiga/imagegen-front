// Provider-neutral chat, used by the prompt helper and the pixel assistant.
// Each chat service converts these turns to its own API format.

import type { ConnectionConfig, ConnectionKind } from "./types";

export interface ChatImage {
  mime: string;
  base64: string;
}

export interface ChatToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  text: string;
  images?: ChatImage[];
  isError?: boolean;
}

export interface UserTurn {
  role: "user";
  text: string;
  images?: ChatImage[];
}

export interface AssistantTurn {
  role: "assistant";
  text: string;
  toolCalls: ToolCall[];
  /**
   * The reply exactly as the service sent it. It is sent back unchanged to the
   * same service: reasoning and thinking blocks must not be rebuilt or edited.
   */
  raw?: { service: ConnectionKind; data: unknown };
}

export interface ToolTurn {
  role: "tool";
  results: ToolResult[];
}

/** A conversation is append-only: earlier turns are never edited. */
export type ChatTurn = UserTurn | AssistantTurn | ToolTurn;

export type Effort = "low" | "medium" | "high";

export interface ChatRequest {
  model: string;
  system: string;
  turns: ChatTurn[];
  tools?: ChatToolSpec[];
  effort?: Effort;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with each piece of reply text as it arrives. */
  onText?: (delta: string) => void;
  /** Called when the reply is started over; text passed to onText so far is void. */
  onRestart?: () => void;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface ChatReply {
  turn: AssistantTurn;
  stop: StopReason;
  /** The model that answered; differs from the request after a fallback. */
  model: string;
  /** Readable summary of the model's reasoning, when the service gives one. */
  reasoning?: string;
}

export interface ChatModel {
  id: string;
  label?: string;
  /** Accepts images. */
  vision?: boolean;
}

export interface ChatService {
  defaultModel: string;
  listModels: (config: ConnectionConfig, signal?: AbortSignal) => Promise<ChatModel[]>;
  send: (request: ChatRequest, config: ConnectionConfig) => Promise<ChatReply>;
}
