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

test("a raw provider body that is plain text or an object is used as it is", () => {
  const text = JSON.stringify({ error: { message: "short…", metadata: { raw: "upstream said no" } } });
  assert.equal(describeHttpError(400, text, URL), "openrouter.ai returned 400: upstream said no");
  const object = JSON.stringify({ error: { message: "short…", metadata: { raw: { error: { message: "full reason" } } } } });
  assert.equal(describeHttpError(400, object, URL), "openrouter.ai returned 400: full reason");
});

test("without a usable raw body the API's own message stays", () => {
  const empty = JSON.stringify({ error: { message: "Model not found", metadata: { raw: "{}" } } });
  assert.equal(describeHttpError(404, empty, URL), "openrouter.ai returned 404: Model not found");
  assert.equal(describeHttpError(401, '{"error":{}}', "https://api.runpod.ai/v2/x/run"), "api.runpod.ai returned 401");
  assert.equal(describeHttpError(502, "Bad gateway", URL), "openrouter.ai returned 502: Bad gateway");
});
