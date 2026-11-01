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
export function nearestAspectRatio(width: number, height: number, ratios: readonly string[] = RATIOS): string {
  const target = Math.log(width / height);
  let best = ratios[0];
  let distance = Infinity;
  for (const ratio of ratios) {
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

/** One entry of a model's `supported_parameters` in GET /images/models. */
export type ImageParamSpec =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

export type SupportedImageParams = Record<string, ImageParamSpec>;

/** Pixels on the long side for a resolution value such as "768", "1K" or "1.5K". */
const tierPixels = (value: string) => (/k$/i.test(value) ? parseFloat(value) * 1024 : parseFloat(value));

/**
 * Fits an /images request body to what the model says it accepts. Parameters
 * it does not list are dropped (OpenRouter rejects them with a 400), and an
 * aspect ratio or resolution it lacks is swapped for its nearest one. Without
 * a list (the model is unknown) the body is sent as it is.
 */
export function fitImageBody(
  body: Record<string, unknown>,
  supported: SupportedImageParams | undefined,
): { body: Record<string, unknown>; dropped: string[] } {
  if (!supported) return { body, dropped: [] };
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === "model" || key === "prompt") {
      out[key] = value;
      continue;
    }
    const spec = supported[key];
    if (!spec) {
      dropped.push(key);
      continue;
    }
    if (spec.type === "range" && typeof value === "number") {
      out[key] = Math.min(spec.max, Math.max(spec.min, value));
      continue;
    }
    if (spec.type !== "enum" || typeof value !== "string" || spec.values.includes(value)) {
      out[key] = value;
      continue;
    }
    if (key === "aspect_ratio") {
      const ratios = spec.values.filter((v) => /^\d+:\d+$/.test(v));
      const [w, h] = value.split(":").map(Number);
      if (ratios.length && w && h) out[key] = nearestAspectRatio(w, h, ratios);
      else dropped.push(key);
    } else if (key === "resolution") {
      const wanted = tierPixels(value);
      const tiers = spec.values.filter((v) => Number.isFinite(tierPixels(v))).sort((a, b) => tierPixels(a) - tierPixels(b));
      const fit = tiers.find((v) => tierPixels(v) >= wanted) ?? tiers.at(-1);
      if (fit) out[key] = fit;
      else dropped.push(key);
    } else {
      dropped.push(key);
    }
  }
  return { body: out, dropped };
}

/**
 * A seed the model accepts: wrapped into the range it lists, or into 32 bits
 * when it lists none. Wrapped rather than clamped, so seeds past the end stay
 * distinct instead of all becoming the maximum.
 */
export function fitSeed(seed: number, spec: ImageParamSpec | undefined): number {
  const [min, max] = spec?.type === "range" ? [spec.min, spec.max] : [0, 2 ** 32 - 1];
  const span = max - min + 1;
  return min + ((((seed - min) % span) + span) % span);
}

/** Whether `slug` looks like an OpenRouter provider slug, such as "openai" or "black-forest-labs". */
export const isProviderSlug = (slug: string) => /^[a-z0-9][a-z0-9._-]*$/.test(slug);

/**
 * Sorts provider-specific option values onto the providers that accept them.
 * `accepted` maps each provider slug to the keys it lists in
 * allowed_passthrough_parameters (undefined when it could not be read).
 * Returns provider.options for the request, or undefined when nothing goes,
 * and the keys no provider took.
 */
export function passthroughOptions(
  values: Record<string, string>,
  accepted: Record<string, string[]> | undefined,
): { options: Record<string, Record<string, string>> | undefined; unsent: string[] } {
  // No prototype, so no key, whatever it is, can reach Object.prototype.
  const options: Record<string, Record<string, string>> = Object.create(null);
  const unsent: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const slugs = Object.entries(accepted ?? {}).filter(([, keys]) => keys.includes(key));
    if (!slugs.length) unsent.push(key);
    for (const [slug] of slugs) (options[slug] ??= {})[key] = value;
  }
  // Copied as own properties into a plain object for the request body.
  return { options: Object.keys(options).length ? { ...options } : undefined, unsent };
}

/**
 * A model id ("owner/name") as URL path segments, each encoded; null when it
 * is not one. The id is typed freely in the Model field, and without this a
 * "?", "#" or ".." in it would change which OpenRouter URL the key goes to.
 */
export function modelPath(model: string): string | null {
  const segments = model.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) return null;
  return segments.map(encodeURIComponent).join("/");
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
