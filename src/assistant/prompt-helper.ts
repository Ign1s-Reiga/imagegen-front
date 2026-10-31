import type { ChatToolSpec } from "@/providers/chat";
import type { Assistant } from "@/store/app";

import { assistantConfig } from "./config";

export interface PromptTarget {
  /** Backend name, e.g. "OpenAI" or "ComfyUI". */
  backend: string;
  /** Model or workflow name; empty when unknown. */
  model: string;
  /** The backend takes a negative prompt. */
  negative: boolean;
  /**
   * "image": a whole picture. "sprite": a pixel-art sprite; the app adds the
   * style words itself. "sprite-edit": a change to part of a sprite.
   */
  purpose: "image" | "sprite" | "sprite-edit";
}

export interface ImprovedPrompt {
  prompt: string;
  negativePrompt?: string;
}

const SET_PROMPT: ChatToolSpec = {
  name: "set_prompt",
  description: "Give the rewritten prompt.",
  schema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The rewritten prompt." },
      negative_prompt: {
        type: "string",
        description: "Things to keep out of the image. Only for models that take a negative prompt.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
};

const PURPOSE: Record<PromptTarget["purpose"], string> = {
  image: "Keep it under 120 words unless the user's prompt is already longer.",
  sprite:
    "The prompt makes one pixel-art game sprite. The app adds the pixel-art style words itself, so describe only the subject: what it is, its pose and view (side, front or three-quarter), silhouette, main colours and props. Keep it under 40 words.",
  "sprite-edit":
    "The prompt says what to change in one area of an existing pixel-art sprite. Describe the change and how the changed part should look, in under 30 words.",
};

function systemPrompt(target: PromptTarget): string {
  return [
    "You rewrite prompts for image generation models. Keep the user's subject, intent and every specific detail they gave, and add what the model needs to render it well: subject, composition, lighting, style, colour and medium, roughly in that order of importance. Do not invent a different subject.",
    `The prompt is for ${target.model ? `${target.model} on ${target.backend}` : target.backend}. Diffusion checkpoints (Stable Diffusion 1.5, SDXL, Pony, Illustrious) respond best to comma-separated descriptive phrases. FLUX, GPT Image, Gemini, Seedream, Qwen-Image and other recent models respond best to clear natural sentences. Judge from the model name; when you cannot tell, write clear sentences.`,
    PURPOSE[target.purpose],
    target.negative
      ? "This model takes a negative prompt: also give a short negative_prompt, keeping the user's existing items."
      : "This model takes no negative prompt, so give none; describe what you want instead of what to avoid.",
    "Write in the language of the user's prompt. Reply only by calling set_prompt.",
  ].join("\n\n");
}

export async function improvePrompt(
  assistant: Assistant,
  input: { prompt: string; negativePrompt?: string },
  target: PromptTarget,
  signal: AbortSignal,
): Promise<ImprovedPrompt> {
  const config = await assistantConfig(assistant);
  const lines = [`Prompt: ${input.prompt.trim()}`];
  if (target.negative && input.negativePrompt?.trim()) lines.push(`Negative prompt: ${input.negativePrompt.trim()}`);
  const reply = await assistant.chat.send(
    {
      model: assistant.model,
      system: systemPrompt(target),
      turns: [{ role: "user", text: lines.join("\n") }],
      tools: [SET_PROMPT],
      effort: "low",
      maxTokens: 16000,
      signal,
    },
    config,
  );
  if (reply.stop === "refusal") throw new Error(`${reply.model} declined to rewrite this prompt.`);
  const call = reply.turn.toolCalls.find((c) => c.name === SET_PROMPT.name)?.input as
    | { prompt?: unknown; negative_prompt?: unknown }
    | undefined;
  // A model that answers in plain text instead of calling the tool still gives a usable prompt.
  const prompt = (typeof call?.prompt === "string" ? call.prompt : reply.turn.text).trim();
  if (!prompt) throw new Error(`${reply.model} returned no prompt.`);
  const negative = typeof call?.negative_prompt === "string" ? call.negative_prompt.trim() : undefined;
  return { prompt, negativePrompt: target.negative ? negative : undefined };
}
