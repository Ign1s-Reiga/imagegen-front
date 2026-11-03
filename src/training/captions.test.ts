import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptSuggestion, captionSystemPrompt, datasetGuidance, hasTrigger, normalizeCaption, suggestCaptions, type CaptionedItem } from "./captions.ts";

test("replies become captions with the trigger once, without beauty words", () => {
  assert.equal(normalizeCaption("Caption: A beautiful woman in a red coat, park, daylight", "ohwx"), "photo of ohwx person, A woman in a red coat, park, daylight");
  assert.equal(normalizeCaption('"photo of ohwx person, smiling, close-up"', "ohwx"), "photo of ohwx person, smiling, close-up");
  assert.equal(normalizeCaption("ohwx person wearing glasses,\nindoors", "ohwx"), "photo of ohwx person, wearing glasses, indoors");
  assert.equal(normalizeCaption("", "ohwx"), "photo of ohwx person");
  assert.ok(hasTrigger("Photo of OHWX person", "ohwx"));
  assert.ok(!hasTrigger("photo of ohwxy person", "ohwx"));
});

test("the instructions keep identity to the token", () => {
  const prompt = captionSystemPrompt("ohwx");
  assert.match(prompt, /photo of ohwx person/);
  assert.match(prompt, /Never guess or state who the person is/);
  assert.match(prompt, /beauty words/);
});

const item = (patch: Partial<CaptionedItem>): CaptionedItem => ({ id: "a", caption: "", captionSource: "", captionSuggestion: null, ...patch });

test("a caption the user wrote is kept unless they choose to replace it", () => {
  const manual = item({ caption: "photo of ohwx person, my words", captionSource: "manual", captionSuggestion: "suggested" });
  assert.equal(acceptSuggestion(manual, false), null);
  assert.deepEqual(acceptSuggestion(manual, true), { caption: "suggested", captionSource: "assistant", captionSuggestion: null });
  assert.deepEqual(acceptSuggestion(item({ captionSuggestion: "s" }), false)?.caption, "s");
  // An emptied manual caption is no longer the user's text to protect.
  assert.ok(acceptSuggestion(item({ captionSource: "manual", captionSuggestion: "s" }), false));
  assert.equal(acceptSuggestion(item({}), true), null);
});

test("suggestions are saved one by one and stop at cancel", async () => {
  const items = ["a", "b", "c", "d"].map((id) => item({ id }));
  const controller = new AbortController();
  const saved: string[] = [];
  const result = await suggestCaptions(
    items,
    async (i) => {
      if (i.id === "b") throw new Error("rate limited");
      if (i.id === "c") controller.abort();
      return `caption ${i.id}`;
    },
    async (i, s) => {
      saved.push(`${i.id}:${s}`);
    },
    controller.signal,
    () => {},
  );
  assert.deepEqual(saved, ["a:caption a"]);
  assert.equal(result.done, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.error, "rate limited");
});

test("guidance never promises a result", () => {
  const notes = datasetGuidance([
    { category: "face", included: true, width: 600, height: 800 },
    { category: "upper-body", included: true, width: 1200, height: 1600 },
  ]);
  assert.ok(notes.some((n) => /full body/.test(n)));
  assert.ok(notes.some((n) => /under 768/.test(n)));
  assert.ok(!notes.some((n) => /guarantee|enough photos/i.test(n)));
});
