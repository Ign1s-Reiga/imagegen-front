// Caption help for training photos. Captions are the user's: suggestions
// from an assistant are kept apart until accepted, and a caption the user
// wrote is only replaced when they choose to replace it.

export interface CaptionedItem {
  id: string;
  caption: string;
  /** "manual" once the user has typed or accepted it; "" when never set. */
  captionSource: "" | "manual" | "assistant";
  captionSuggestion: string | null;
}

/**
 * What the assistant is asked to do. It describes what varies from photo
 * to photo, so the LoRA learns the person from what stays the same.
 */
export function captionSystemPrompt(trigger: string): string {
  return [
    "You write training captions for a personal identity LoRA. Each photo shows the same person, who is referred to only by the token",
    `"${trigger}". Write one caption per photo, in this form: "photo of ${trigger} person, " followed by a comma-separated description.`,
    "",
    "Describe only what you can see and what changes between photos: framing (close-up, upper body, full body), pose and",
    "head angle, expression, clothing and accessories, hair styling if it is clearly visible, the setting and background, and the lighting.",
    "",
    "Never guess or state who the person is, their name, age, ethnicity, nationality or anything not visible. Do not describe their",
    "face shape, eye colour, skin, build or other fixed features: those are what the token stands for. Do not add compliments or",
    'beauty words such as "beautiful", "handsome", "attractive" or "perfect". Do not invent details you cannot see. If something is',
    "unclear, leave it out. Reply with the caption only, on one line, under 60 words.",
  ].join("\n");
}

export const CAPTION_USER_TEXT = "Caption this training photo.";

const BEAUTY = /\b(beautiful|gorgeous|handsome|attractive|stunning|pretty|perfect|flawless|sexy|cute|lovely)\b,?\s*/gi;

/**
 * A reply made into a caption: one line, no quotes or label, beauty words
 * removed, and the trigger phrase at the start exactly once.
 */
export function normalizeCaption(reply: string, trigger: string): string {
  let text = reply
    .replace(/\r?\n+/g, " ")
    .replace(/^\s*(caption\s*:)\s*/i, "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(BEAUTY, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Drop every mention of the token, then put the one phrase in front.
  text = text
    .replace(new RegExp(`\\b(a\\s+|an\\s+)?(photo|picture|image)\\s+of\\s+${escaped}(\\s+person)?\\b,?\\s*`, "gi"), "")
    .replace(new RegExp(`\\b${escaped}\\b(\\s+person)?,?\\s*`, "gi"), "")
    .replace(/^[,;\s]+/, "")
    .replace(/\s+,/g, ",")
    .trim();
  return text ? `photo of ${trigger} person, ${text}` : `photo of ${trigger} person`;
}

/** Whether a caption mentions the trigger token as a word. */
export function hasTrigger(caption: string, trigger: string): boolean {
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(caption);
}

/** Photos a caption run should ask about: chosen ones without a pending suggestion. */
export function needsSuggestion(item: CaptionedItem, overwriteSuggestions: boolean) {
  return overwriteSuggestions || !item.captionSuggestion;
}

/**
 * The change accepting a suggestion makes, or null when it should not
 * apply: a caption the user wrote stays unless `replaceManual` is set.
 */
export function acceptSuggestion(
  item: CaptionedItem,
  replaceManual: boolean,
): { caption: string; captionSource: "assistant"; captionSuggestion: null } | null {
  if (!item.captionSuggestion) return null;
  if (item.captionSource === "manual" && item.caption.trim() && !replaceManual) return null;
  return { caption: item.captionSuggestion, captionSource: "assistant", captionSuggestion: null };
}

export interface CaptionProgress {
  done: number;
  total: number;
  failed: number;
  /** The last error, when a photo could not be captioned. */
  error?: string;
}

/**
 * Asks for suggestions one photo at a time, saving each as it arrives so
 * stopping keeps what was done. Stops at the signal; a failure on one photo
 * is counted and the rest go on.
 */
export async function suggestCaptions(
  items: CaptionedItem[],
  ask: (item: CaptionedItem, signal: AbortSignal) => Promise<string>,
  save: (item: CaptionedItem, suggestion: string) => Promise<void>,
  signal: AbortSignal,
  onProgress: (progress: CaptionProgress) => void,
): Promise<CaptionProgress> {
  const progress: CaptionProgress = { done: 0, total: items.length, failed: 0 };
  onProgress({ ...progress });
  for (const item of items) {
    if (signal.aborted) break;
    try {
      const suggestion = await ask(item, signal);
      if (signal.aborted) break;
      await save(item, suggestion);
      progress.done++;
    } catch (err) {
      if (signal.aborted) break;
      progress.failed++;
      progress.error = err instanceof Error ? err.message : String(err);
    }
    onProgress({ ...progress });
  }
  return progress;
}

/** Non-blocking notes on how varied the photos are. Never a promise of likeness. */
export function datasetGuidance(items: { category: string; included: boolean; width: number | null; height: number | null }[]): string[] {
  const used = items.filter((i) => i.included);
  const notes: string[] = [];
  if (!used.length) return ["Add photos of the person, then include the ones to train on."];
  const count = (category: string) => used.filter((i) => i.category === category).length;
  const tagged = used.filter((i) => i.category).length;
  if (tagged && !count("face")) notes.push("No photo is tagged as a face close-up. Close-ups carry most of a face's detail.");
  if (tagged && !count("full-body")) notes.push("No photo is tagged full body. Without some, body proportions are learned from cropped shots only.");
  const small = used.filter((i) => i.width && i.height && Math.min(i.width, i.height) < 768).length;
  if (small) notes.push(`${small} photo${small === 1 ? " is" : "s are"} under 768 pixels on the short side and will be scaled up for 1024 training.`);
  notes.push(
    "Variety helps the LoRA separate the person from everything else: different angles, expressions, clothing, places and light. Near-identical shots add little.",
  );
  return notes;
}
