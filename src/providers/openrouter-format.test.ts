import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatTurn } from "./chat.ts";
import {
  INVALID_JSON,
  fromOpenRouterCompletion,
  nearestAspectRatio,
  parseOpenRouterCredit,
  resolutionTier,
  toOpenRouterMessages,
} from "./openrouter-format.ts";

const png = { mime: "image/png", base64: "AAAA" };

test("turns become chat completion messages", () => {
  const echoed = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fill", arguments: "{}" } }], reasoning_details: [{ type: "x" }] };
  const turns: ChatTurn[] = [
    { role: "user", text: "Hi", images: [png] },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "fill", input: {} }], raw: { service: "openrouter", data: echoed } },
    { role: "tool", results: [{ id: "c1", text: "Filled", images: [png] }, { id: "c2", text: "No such frame", isError: true }] },
  ];
  const messages = toOpenRouterMessages("Be brief.", turns);
  assert.deepEqual(messages[0], { role: "system", content: "Be brief." });
  assert.deepEqual(messages[1].content, [
    { type: "text", text: "Hi" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
  assert.equal(messages[2], echoed, "the model's own message goes back as received");
  assert.deepEqual(messages[3], { role: "tool", tool_call_id: "c1", content: "Filled" });
  assert.deepEqual(messages[4], { role: "tool", tool_call_id: "c2", content: "Error: No such frame" });
  assert.equal(messages[5].role, "user", "tool images follow as a user message");
  assert.equal((messages[5].content as unknown[]).length, 2);
});

test("replies from another service are rebuilt with JSON arguments", () => {
  const [, assistant] = toOpenRouterMessages("", [
    { role: "assistant", text: "Ok", toolCalls: [{ id: "toolu_1", name: "clear", input: { x: 1 } }], raw: { service: "anthropic", data: [] } },
  ]);
  assert.deepEqual(assistant, {
    role: "assistant",
    content: "Ok",
    tool_calls: [{ id: "toolu_1", type: "function", function: { name: "clear", arguments: '{"x":1}' } }],
  });
});

test("completions read back with tool calls and stop reasons", () => {
  const reply = fromOpenRouterCompletion(
    {
      model: "anthropic/claude-opus-5.5",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Drawing.",
            reasoning: "Think",
            tool_calls: [
              { id: "a", type: "function", function: { name: "fill", arguments: '{"x":2}' } },
              { id: "b", type: "function", function: { name: "clear", arguments: "{oops" } },
            ],
          },
        },
      ],
    },
    "requested",
  );
  assert.equal(reply.turn.text, "Drawing.");
  assert.equal(reply.stop, "tool_use");
  assert.equal(reply.model, "anthropic/claude-opus-5.5");
  assert.deepEqual(reply.turn.toolCalls[0].input, { x: 2 });
  assert.deepEqual(reply.turn.toolCalls[1].input, { [INVALID_JSON]: "{oops" });
  assert.equal((reply.turn.raw?.data as { reasoning?: string }).reasoning, "Think");

  const done = (finish_reason: string) =>
    fromOpenRouterCompletion({ choices: [{ finish_reason, message: { role: "assistant", content: [{ type: "text", text: "x" }] } }] }, "m").stop;
  assert.equal(done("stop"), "end");
  assert.equal(done("length"), "max_tokens");
  assert.equal(done("content_filter"), "refusal");
  assert.throws(() => fromOpenRouterCompletion({ error: { message: "No credits" } }, "m"), /No credits/);
  assert.throws(() => fromOpenRouterCompletion({ choices: [] }, "m"), /no reply/);
});

test("sizes map to aspect ratios and resolution tiers", () => {
  assert.equal(nearestAspectRatio(1024, 1024), "1:1");
  assert.equal(nearestAspectRatio(1536, 1024), "3:2");
  assert.equal(nearestAspectRatio(1920, 1080), "16:9");
  assert.equal(nearestAspectRatio(832, 1216), "2:3");
  assert.equal(nearestAspectRatio(2520, 1080), "21:9");
  assert.equal(resolutionTier(1024, 1024), "1K");
  assert.equal(resolutionTier(2048, 1152), "2K");
  assert.equal(resolutionTier(4096, 4096), "4K");
});

test("credit: month spend from the key, balance from a management key", () => {
  assert.deepEqual(parseOpenRouterCredit({ data: { usage_monthly: 3.25 } }), {
    monthSpend: { amount: 3.25, currency: "USD" },
    balance: undefined,
    low: undefined,
  });
  const both = parseOpenRouterCredit({ data: { usage_monthly: 1 } }, { data: { total_credits: 10, total_usage: 8.5 } });
  assert.deepEqual(both.balance, { amount: 1.5, currency: "USD" });
  assert.equal(both.low, true);
  assert.throws(() => parseOpenRouterCredit({}), /did not return/);
});
