// Asks the chosen assistant (Claude or OpenRouter) to suggest one photo's
// caption. Only runs when the user starts it, after being told the photos
// go to that service. The image sent is a reduced copy without metadata.

import { assistantConfig } from "@/assistant/config";
import { bytesToBase64 } from "@/lib/bytes";
import type { Assistant } from "@/store/app";

import { captionImage, type DatasetItem } from "./api";
import { CAPTION_USER_TEXT, captionSystemPrompt, normalizeCaption } from "./captions";

export function captioner(assistant: Assistant, trigger: string) {
  let config: Awaited<ReturnType<typeof assistantConfig>> | null = null;
  return async (item: DatasetItem, signal: AbortSignal): Promise<string> => {
    config ??= await assistantConfig(assistant);
    const bytes = await captionImage(item.id);
    const reply = await assistant.chat.send(
      {
        model: assistant.model,
        system: captionSystemPrompt(trigger),
        turns: [{ role: "user", text: CAPTION_USER_TEXT, images: [{ mime: "image/jpeg", base64: bytesToBase64(bytes as Uint8Array<ArrayBuffer>) }] }],
        effort: "low",
        maxTokens: 2000,
        signal,
      },
      config,
    );
    if (reply.stop === "refusal") throw new Error(`${reply.model} declined to caption ${item.originalName}.`);
    const text = reply.turn.text.trim();
    if (!text) throw new Error(`${reply.model} returned no caption for ${item.originalName}.`);
    return normalizeCaption(text, trigger);
  };
}
