import assert from "node:assert/strict";
import { test } from "node:test";

import { midSentence } from "./text.ts";

test("midSentence lowercases the first word", () => {
  assert.equal(midSentence("Endpoint ID"), "endpoint ID");
  assert.equal(midSentence("Admin key"), "admin key");
});

test("midSentence keeps acronyms", () => {
  assert.equal(midSentence("API key"), "API key");
  assert.equal(midSentence("URL"), "URL");
});

test("midSentence leaves single letters and non-words alone", () => {
  assert.equal(midSentence("A"), "a");
  assert.equal(midSentence(""), "");
  assert.equal(midSentence("3D model"), "3D model");
});
