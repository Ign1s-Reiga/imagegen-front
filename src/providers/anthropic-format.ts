// Converts neutral chat turns to Claude Messages API shapes and back.
// Type imports only, so it can be unit tested with Node directly.

import type Anthropic from "@anthropic-ai/sdk";

import type { ChatImage, ChatReply, ChatTurn, StopReason } from "./chat.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ImageMime = Anthropic.Beta.BetaBase64ImageSource["media_type"];

const image = (img: ChatImage): Anthropic.Beta.BetaImageBlockParam => ({
  type: "image",
  source: { type: "base64", media_type: img.mime as ImageMime, data: img.base64 },
});

export function toAnthropicMessages(turns: ChatTurn[]): MessageParam[] {
  return turns.map((turn): MessageParam => {
    switch (turn.role) {
      case "user":
        return { role: "user", content: [...(turn.images ?? []).map(image), { type: "text", text: turn.text || "(empty)" }] };
      case "assistant": {
        // Claude's own replies go back exactly as received (thinking blocks included).
        if (turn.raw?.service === "anthropic") {
          return { role: "assistant", content: turn.raw.data as Anthropic.Beta.BetaContentBlockParam[] };
        }
        const content: Anthropic.Beta.BetaContentBlockParam[] = [];
        if (turn.text) content.push({ type: "text", text: turn.text });
        for (const call of turn.toolCalls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: (call.input ?? {}) as Record<string, unknown> });
        }
        if (!content.length) content.push({ type: "text", text: "(no reply)" });
        return { role: "assistant", content };
      }
      case "tool":
        return {
          role: "user",
          content: turn.results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            ...(r.isError ? { is_error: true } : {}),
            content: [{ type: "text", text: r.text || "(no output)" }, ...(r.images ?? []).map(image)],
          })),
        };
    }
  });
}

const STOP: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
};

export function fromAnthropicMessage(message: Anthropic.Beta.BetaMessage): ChatReply {
  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: ChatReply["turn"]["toolCalls"] = [];
  for (const block of message.content) {
    if (block.type === "text") text.push(block.text);
    else if (block.type === "thinking" && block.thinking) reasoning.push(block.thinking);
    else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return {
    turn: { role: "assistant", text: text.join(""), toolCalls, raw: { service: "anthropic", data: message.content } },
    stop: STOP[message.stop_reason ?? ""] ?? "other",
    model: message.model,
    reasoning: reasoning.join("\n\n") || undefined,
  };
}

/** Claude 4.6 and later think adaptively and take an effort level. */
export function hasAdaptiveThinking(model: string): boolean {
  if (/^claude-(fable|mythos)-/.test(model)) return true;
  const m = /^claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
}

/** Models that can hand a declined request to a fallback model server-side. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export const usesServerFallback = (model: string) => FALLBACK_MODELS.has(model);
