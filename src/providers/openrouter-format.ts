// OpenRouter request and response shapes. No runtime imports, so it can be
// unit tested with Node directly.

import type { ChatImage, ChatReply, ChatTurn, StopReason, ToolCall } from "./chat.ts";
import { LOW_BALANCE } from "./credit.ts";
import type { CreditInfo } from "./types.ts";

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
  reasoning?: string | null;
  reasoning_details?: unknown;
}

export interface OpenRouterCompletion {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: OpenRouterMessage;
    error?: { message?: string };
  }[];
  error?: { message?: string };
}

const imagePart = (img: ChatImage) => ({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.base64}` } });

export function toOpenRouterMessages(system: string, turns: ChatTurn[]): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: turn.text }, ...(turn.images ?? []).map(imagePart)] });
    } else if (turn.role === "assistant") {
      // The model's own message goes back as received, reasoning details included.
      if (turn.raw?.service === "openrouter") {
        messages.push(turn.raw.data as OpenRouterMessage);
        continue;
      }
      messages.push({
        role: "assistant",
        content: turn.text || null,
        ...(turn.toolCalls.length
          ? {
              tool_calls: turn.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    } else {
      for (const r of turn.results) {
        messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.text}` : r.text });
      }
      // Tool messages are text only, so images follow in a user message.
      const images = turn.results.flatMap((r) => r.images ?? []);
      if (images.length) {
        messages.push({
          role: "user",
          content: [{ type: "text", text: "Images returned by the tool calls above, in order:" }, ...images.map(imagePart)],
        });
      }
    }
  }
  return messages;
}

/** Marks tool arguments that were not valid JSON, so the tool reports it instead of running. */
export const INVALID_JSON = "__invalid_json";

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { [INVALID_JSON]: text };
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function stopReason(finish: string | null | undefined, toolCalls: ToolCall[]): StopReason {
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (finish === "tool_calls" || toolCalls.length) return "tool_use";
  if (!finish || finish === "stop") return "end";
  return "other";
}

export function fromOpenRouterCompletion(json: OpenRouterCompletion, requestedModel: string): ChatReply {
  const choice = json.choices?.[0];
  const problem = json.error?.message ?? choice?.error?.message;
  if (problem) throw new Error(`OpenRouter: ${problem}`);
  const message = choice?.message;
  if (!message) throw new Error("OpenRouter returned no reply.");
  const toolCalls = (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }));
  // Only the fields a request accepts are kept for sending back.
  const echo: OpenRouterMessage = { role: "assistant", content: message.content ?? null };
  if (message.tool_calls?.length) echo.tool_calls = message.tool_calls;
  if (message.reasoning) echo.reasoning = message.reasoning;
  if (message.reasoning_details) echo.reasoning_details = message.reasoning_details;
  return {
    turn: { role: "assistant", text: contentText(message.content), toolCalls, raw: { service: "openrouter", data: echo } },
    stop: stopReason(choice?.finish_reason, toolCalls),
    model: json.model ?? requestedModel,
    reasoning: message.reasoning || undefined,
  };
}

/** Aspect ratios nearly every OpenRouter image model accepts. */
const RATIOS = ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "9:21", "21:9"];

/** The supported aspect ratio closest to width:height. */
export function nearestAspectRatio(width: number, height: number): string {
  const target = Math.log(width / height);
  let best = RATIOS[0];
  let distance = Infinity;
  for (const ratio of RATIOS) {
    const [a, b] = ratio.split(":").map(Number);
    const d = Math.abs(Math.log(a / b) - target);
    if (d < distance) {
      distance = d;
      best = ratio;
    }
  }
  return best;
}

/** The resolution tier that covers the longer side. */
export function resolutionTier(width: number, height: number): string {
  const side = Math.max(width, height);
  if (side <= 1280) return "1K";
  if (side <= 2560) return "2K";
  return "4K";
}

const usd = (amount: unknown) => (typeof amount === "number" && Number.isFinite(amount) ? { amount, currency: "USD" } : undefined);

/** GET /key (month spend) and, with a management key, GET /credits (balance). */
export function parseOpenRouterCredit(key: unknown, credits?: unknown): CreditInfo {
  const k = (key as { data?: { usage_monthly?: unknown } })?.data;
  const c = (credits as { data?: { total_credits?: unknown; total_usage?: unknown } })?.data;
  const monthSpend = usd(k?.usage_monthly);
  const total = usd(c?.total_credits);
  const used = usd(c?.total_usage);
  const balance = total && used ? { amount: total.amount - used.amount, currency: "USD" } : undefined;
  if (!monthSpend && !balance) throw new Error("OpenRouter did not return usage for this key.");
  return { monthSpend, balance, low: balance ? balance.amount < LOW_BALANCE : undefined };
}
