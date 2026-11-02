import assert from "node:assert/strict";
import { test } from "node:test";

import { describeHttpError } from "./http-error.ts";

const URL = "https://openrouter.ai/api/v1/chat/completions";

test("an OpenRouter error gives the provider's full message, not the shortened one", () => {
  const full =
    "Your request was rejected by the safety system. If you believe this is an error, contact us at help.openai.com and include the request ID req_1. safety_violations=[sexual].";
  const body = JSON.stringify({
    error: {
      code: 400,
      message: `${full.slice(0, 160)}…`,
      metadata: { provider_name: "OpenAI", raw: JSON.stringify({ error: { message: full, type: "image_generation_user_error" } }) },
    },
  });
  assert.equal(describeHttpError(400, body, URL), `openrouter.ai returned 400: ${full}`);
});

test("a plain-text raw body is used only when it is the message OpenRouter shortened", () => {
  const same = JSON.stringify({ error: { message: "upstream said…", metadata: { raw: "upstream said no, because of X" } } });
  assert.equal(describeHttpError(400, same, URL), "openrouter.ai returned 400: upstream said no, because of X");
  const object = JSON.stringify({ error: { message: "short…", metadata: { raw: { error: { message: "full reason" } } } } });
  assert.equal(describeHttpError(400, object, URL), "openrouter.ai returned 400: full reason");
});

test("a raw body with no readable message keeps OpenRouter's message", () => {
  const html = JSON.stringify({ error: { message: "Provider returned error…", metadata: { raw: "<html><body>502 Bad Gateway</body></html>" } } });
  assert.equal(describeHttpError(502, html, URL), "openrouter.ai returned 502: Provider returned error…");
  const noMessage = JSON.stringify({ error: { message: "Provider returned error…", metadata: { raw: '{"errors":[{"code":"x"}]}' } } });
  assert.equal(describeHttpError(400, noMessage, URL), "openrouter.ai returned 400: Provider returned error…");
  // A complete message is not swapped for the provider's.
  const whole = JSON.stringify({ error: { message: "Rate limited", metadata: { raw: '{"error":{"message":"429 from upstream"}}' } } });
  assert.equal(describeHttpError(429, whole, URL), "openrouter.ai returned 429: Rate limited");
});

test("a long message is kept up to 4000 characters, then marked as cut", () => {
  const long = "x".repeat(1000);
  assert.equal(describeHttpError(400, long, URL), `openrouter.ai returned 400: ${long}`);
  const page = "y".repeat(5000);
  assert.equal(describeHttpError(502, page, URL), `openrouter.ai returned 502: ${"y".repeat(4000)}…`);
});

test("a cut never splits an emoji", () => {
  const text = `${"z".repeat(3999)}😀tail`.padEnd(5000, "z");
  assert.equal(describeHttpError(400, text, URL), `openrouter.ai returned 400: ${"z".repeat(3999)}…`);
});

test("without a usable raw body the API's own message stays", () => {
  const empty = JSON.stringify({ error: { message: "Model not found", metadata: { raw: "{}" } } });
  assert.equal(describeHttpError(404, empty, URL), "openrouter.ai returned 404: Model not found");
  assert.equal(describeHttpError(401, '{"error":{}}', "https://api.runpod.ai/v2/x/run"), "api.runpod.ai returned 401");
  assert.equal(describeHttpError(502, "Bad gateway", URL), "openrouter.ai returned 502: Bad gateway");
});
