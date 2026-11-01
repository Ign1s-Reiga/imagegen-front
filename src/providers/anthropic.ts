import Anthropic from "@anthropic-ai/sdk";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { abortError, trimSlash } from "@/lib/http";

import { fromAnthropicMessage, hasAdaptiveThinking, toAnthropicMessages, usesServerFallback } from "./anthropic-format";
import type { ChatModel, ChatReply, ChatRequest, ChatService } from "./chat";
import type { ConnectionConfig, ServiceDefinition } from "./types";

const DEFAULT_BASE = "https://api.anthropic.com";

function client(config: ConnectionConfig) {
  return new Anthropic({
    apiKey: config.apiKey ?? "",
    baseURL: trimSlash(config.baseUrl || DEFAULT_BASE),
    // Requests go through Rust like every other backend; the webview itself has no network access.
    fetch: tauriFetch,
    // The SDK guards against shipping a key to website visitors. Here the key comes
    // from the user's own keychain and stays on their machine.
    dangerouslyAllowBrowser: true,
  });
}

/** API errors as one readable line; aborts become the app's AbortError. */
function describe(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return abortError();
  if (err instanceof Anthropic.APIConnectionError) return new Error(`Could not reach the Claude API: ${err.message}`);
  if (err instanceof Anthropic.APIError) {
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message ?? err.message;
    return new Error(`Claude API returned ${err.status ?? "an error"}: ${detail}`);
  }
  return err;
}

async function stream(request: ChatRequest, config: ConnectionConfig): Promise<ChatReply> {
  const official = trimSlash(config.baseUrl || DEFAULT_BASE) === DEFAULT_BASE;
  const fallback = official && usesServerFallback(request.model);
  const adaptive = hasAdaptiveThinking(request.model);
  const response = client(config).beta.messages.stream(
    {
      model: request.model,
      max_tokens: request.maxTokens ?? 64000,
      system: request.system,
      messages: toAnthropicMessages(request.turns),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.schema as Anthropic.Beta.BetaTool.InputSchema,
              // Large drawing inputs stream as they are written. The server no longer
              // validates them, so every tool validates its own input.
              eager_input_streaming: true,
            })),
          }
        : {}),
      ...(adaptive
        ? { thinking: { type: "adaptive" as const, display: "summarized" as const }, output_config: { effort: request.effort ?? "medium" } }
        : {}),
      // The system prompt and tools repeat on every turn of a conversation.
      cache_control: { type: "ephemeral" },
      // A request declined for policy reasons is retried on a fallback model.
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    },
    { signal: request.signal },
  );
  if (request.onText) response.on("text", (delta) => request.onText?.(delta));
  return fromAnthropicMessage(await response.finalMessage());
}

const chat: ChatService = {
  defaultModel: "claude-opus-5-5",

  async listModels(config, signal) {
    const models: ChatModel[] = [];
    try {
      for await (const m of client(config).models.list({ limit: 100 }, { signal })) {
        models.push({ id: m.id, label: m.display_name, vision: true });
      }
    } catch (err) {
      throw describe(err);
    }
    return models;
  },

  async send(request, config) {
    // A tool input that streamed as unparseable JSON rejects the stream; that
    // turn is re-issued. API errors are not retried here (the SDK already did).
    for (let attempt = 0; ; attempt++) {
      try {
        return await stream(request, config);
      } catch (err) {
        if (err instanceof Anthropic.APIError || request.signal?.aborted || attempt >= 2) throw describe(err);
        // The retry streams its own text; what the failed attempt streamed is dropped.
        request.onRestart?.();
      }
    }
  },
};

export const anthropic: ServiceDefinition = {
  kind: "anthropic",
  label: "Claude",
  summary: "Claude from Anthropic, for the prompt helper and the pixel assistant. Claude does not make images.",
  fields: [
    { key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "sk-ant-..." },
    {
      key: "baseUrl",
      label: "API base URL",
      type: "url",
      default: DEFAULT_BASE,
      placeholder: DEFAULT_BASE,
      help: "Change only for a proxy.",
    },
  ],

  async testConnection(config, signal) {
    const models = await chat.listModels(config, signal);
    const has = models.some((m) => m.id === chat.defaultModel);
    return `Key works. ${models.length} Claude model${models.length === 1 ? "" : "s"} available${has ? `, including ${chat.defaultModel}` : ""}.`;
  },

  chat,
};
