import assert from "node:assert/strict";
import { test } from "node:test";

import type Anthropic from "@anthropic-ai/sdk";

import { fromAnthropicMessage, hasAdaptiveThinking, toAnthropicMessages, usesServerFallback } from "./anthropic-format.ts";
import type { ChatTurn } from "./chat.ts";

const png = { mime: "image/png", base64: "iVBORw0KGgo=" };

test("turns become Messages API messages", () => {
  const raw = [
    { type: "thinking", thinking: "plan", signature: "sig" },
    { type: "text", text: "Drawing now." },
    { type: "tool_use", id: "toolu_1", name: "draw_pixels", input: { x: 0 } },
  ];
  const turns: ChatTurn[] = [
    { role: "user", text: "Draw a slime", images: [png] },
    { role: "assistant", text: "Drawing now.", toolCalls: [{ id: "toolu_1", name: "draw_pixels", input: { x: 0 } }], raw: { service: "anthropic", data: raw } },
    { role: "tool", results: [{ id: "toolu_1", text: "Changed 4 pixels", images: [png] }, { id: "toolu_2", text: "bad", isError: true }] },
  ];
  const [user, assistant, tool] = toAnthropicMessages(turns);
  assert.deepEqual(user, {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.base64 } },
      { type: "text", text: "Draw a slime" },
    ],
  });
  // Claude's own reply goes back untouched, thinking block and all.
  assert.equal(assistant.content, raw);
  assert.equal(tool.role, "user");
  const results = tool.content as Anthropic.Beta.BetaToolResultBlockParam[];
  assert.equal(results[0].tool_use_id, "toolu_1");
  assert.equal(results[0].is_error, undefined);
  assert.equal((results[0].content as unknown[]).length, 2, "text and image");
  assert.equal(results[1].is_error, true);
});

test("replies from another service are rebuilt as text and tool_use blocks", () => {
  const [assistant] = toAnthropicMessages([
    { role: "assistant", text: "", toolCalls: [{ id: "call_9", name: "fill", input: { x: 1, y: 2 } }], raw: { service: "openrouter", data: {} } },
  ]);
  assert.deepEqual(assistant.content, [{ type: "tool_use", id: "call_9", name: "fill", input: { x: 1, y: 2 } }]);
  const [empty] = toAnthropicMessages([{ role: "assistant", text: "", toolCalls: [] }]);
  assert.deepEqual(empty.content, [{ type: "text", text: "(no reply)" }], "never an empty content list");
});

test("a message reads back as text, tool calls, reasoning and stop reason", () => {
  const message = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "Outline first.", signature: "s" },
      { type: "text", text: "Here " },
      { type: "text", text: "it is." },
      { type: "tool_use", id: "toolu_a", name: "view_sprite", input: {} },
    ],
    stop_reason: "tool_use",
  } as unknown as Anthropic.Beta.BetaMessage;
  const reply = fromAnthropicMessage(message);
  assert.equal(reply.turn.text, "Here it is.");
  assert.deepEqual(reply.turn.toolCalls, [{ id: "toolu_a", name: "view_sprite", input: {} }]);
  assert.equal(reply.turn.raw?.data, message.content);
  assert.equal(reply.stop, "tool_use");
  assert.equal(reply.reasoning, "Outline first.");
  assert.equal(fromAnthropicMessage({ ...message, stop_reason: "refusal" } as Anthropic.Beta.BetaMessage).stop, "refusal");
  assert.equal(fromAnthropicMessage({ ...message, stop_reason: "max_tokens" } as Anthropic.Beta.BetaMessage).stop, "max_tokens");
});

test("adaptive thinking and server fallback by model", () => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-4-6", "claude-sonnet-4-6"]) {
    assert.ok(hasAdaptiveThinking(model), model);
  }
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5", "gpt-5"]) {
    assert.ok(!hasAdaptiveThinking(model), model);
  }
  assert.ok(usesServerFallback("claude-opus-5-5"));
  assert.ok(!usesServerFallback("claude-haiku-5-5"));
});
