"use client";

/**
 * The pixel assistant: a chat model that edits the open sprite through tools.
 * Every reply loops model turn -> tool calls -> tool results until the model
 * stops calling tools. All edits for one message form a single undo step.
 */
import { z } from "zod";
import { create } from "zustand";

import { assistantConfig } from "@/assistant/config";
import { bytesToBase64 } from "@/lib/bytes";
import { isAbortError } from "@/lib/http";
import type { ChatImage, ChatTurn, ToolCall, ToolResult } from "@/providers/chat";
import type { Progress } from "@/providers/types";
import { activeConnection, activeWorkflow, assistantFor, capabilitiesFor, useApp } from "@/store/app";

import { aiSupport, createSprite, editRegion, varySprite, type Candidate } from "./ai.ts";
import { EDIT_TOOLS, editorSummary, parseToolInput, toolError, toolSpec, type EditorState, type ToolOutput } from "./agent-tools.ts";
import { hexToPacked, keyColorFor, packedToHex } from "./color.ts";
import * as D from "./doc.ts";
import { pixelsToPng } from "./image-io.ts";
import { clampRect, pasteRegion, type Rect } from "./raster.ts";
import { usePixel, type ApplyTarget } from "./store.ts";

/** Model calls per message before the assistant is stopped. */
const MAX_STEPS = 40;

export type AgentEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; done: boolean }
  | { id: string; kind: "tool"; text: string; error?: boolean }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "note"; text: string };

interface AgentState {
  entries: AgentEntry[];
  /** The conversation as sent to the model; append-only. */
  turns: ChatTurn[];
  running: boolean;
  controller: AbortController | null;
  send(text: string): Promise<void>;
  stop(): void;
  reset(): void;
}

const SYSTEM = `You are a pixel artist working in the user's sprite editor. Your tools edit the open sprite, and the user watches the changes live.

Coordinates are in sprite pixels: x grows to the right, y grows down, and (0, 0) is the top-left pixel. Layers are numbered from 1 at the bottom, frames from 1. Drawing tools change the current layer in the current frame; switch with the layers and frames tools.

Colours are "#rrggbb", "transparent" or a palette index. Stay within the palette unless the user asks for other colours; add any you need with set_palette before drawing with them.

draw_pixels is the main drawing tool: write the area as rows of characters, one per pixel. Use draw_rect, draw_line and fill for large simple shapes. After drawing, look at the result with view_sprite (or read_pixels for exact values) and fix what is off before you reply.

Good pixel art has a clear silhouette that reads at actual size, a dark outline (usually a dark hue rather than pure black), two to four tones per material lit from one side, and no stray single pixels or smooth gradients. For animation, duplicate the frame and change only what moves, keeping the character's size and footing steady between frames.

Everything you change for one message is a single undo step for the user, so make the changes rather than asking first; ask only when the request could mean very different results. When you are done, say in a sentence or two what you made or changed.`;

const IMAGE_NOTE = `

generate_image runs the user's image backend. It costs the user money and takes a while, so use it only when they ask for AI-generated art or for a detailed picture you cannot draw well by hand. Its results come back already snapped to the sprite's grid and palette; place one with apply_result, then refine it with the drawing tools.`;

// ---- image backend tools ----

const GenerateInput = z
  .object({
    kind: z
      .enum(["create", "vary", "edit"])
      .describe('"create": a new sprite from the prompt; "vary": new versions of the current frame; "edit": redraw one area of the current frame.'),
    prompt: z.string().min(1).max(1000).describe("What to draw. Describe the subject only; pixel-art style words are added for you."),
    count: z.number().int().min(1).max(4).default(1),
    area: z
      .object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) })
      .strict()
      .optional()
      .describe("For edit: the area to redraw. Default: the user's selection."),
  })
  .strict();

const ApplyInput = z
  .object({
    result: z.string().describe('A result id from generate_image, like "r1".'),
    as: z
      .enum(["layer", "frame", "replace", "area"])
      .describe('"layer": a new layer in this frame; "frame": a new frame; "replace": replace the current layer; "area": for edit results, replace just the edited area.'),
  })
  .strict();

const GENERATE_SPEC = toolSpec(
  "generate_image",
  "Make sprites with the user's image backend (an image model), snapped to this sprite's size and palette. Slow and paid; see the instructions.",
  GenerateInput,
);
const APPLY_SPEC = toolSpec("apply_result", "Place a generate_image result in the sprite.", ApplyInput);

/** Short ids ("r1") for generated results, which the model refers to. */
const resultIds = new Map<string, string>();

interface Outcome {
  output: ToolOutput;
  images: ChatImage[];
}

/** A frame or pixels as a PNG for the model, transparency shown as `background`. */
async function renderPixels(pixels: Uint32Array, width: number, height: number, scale: number, background: number): Promise<ChatImage> {
  const flat = new Uint32Array(pixels.length).fill(background);
  D.blendOver(flat, pixels);
  return { mime: "image/png", base64: bytesToBase64(await pixelsToPng(flat, width, height, scale)) };
}

const viewScale = (doc: D.PixelDoc) => Math.max(1, Math.min(32, Math.floor(768 / Math.max(doc.width, doc.height))));

async function generateImage(raw: unknown, signal: AbortSignal): Promise<Outcome> {
  const parsed = parseToolInput(GenerateInput, raw);
  if ("error" in parsed) return { output: toolError("generate_image", parsed.error), images: [] };
  const input = parsed.data;
  const app = useApp.getState();
  const connection = activeConnection(app);
  const caps = capabilitiesFor(connection, activeWorkflow(app));
  if (!connection || !caps) {
    return { output: toolError("generate_image", "No image backend is connected. Draw by hand instead, or ask the user to add one in Connections."), images: [] };
  }
  const reason = aiSupport(caps)[input.kind];
  if (reason) return { output: toolError("generate_image", reason), images: [] };
  const pixel = usePixel.getState();
  if (pixel.aiJob) return { output: toolError("generate_image", "The image tools are busy with another job. Try again when it finishes."), images: [] };

  let region: Rect | null = null;
  if (input.kind === "edit") {
    const a = input.area;
    region = a ? clampRect({ x: a.x, y: a.y, w: a.width, h: a.height }, pixel.doc.width, pixel.doc.height) : pixel.selection;
    if (!region) return { output: toolError("generate_image", "Give the area to redraw; the user has nothing selected."), images: [] };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  usePixel.setState({ aiJob: { op: input.kind, startedAt: Date.now(), controller, progress: { stage: "queued", message: "Starting" } } });
  const ctx = {
    signal: controller.signal,
    onProgress: (progress: Progress) =>
      usePixel.setState((s) => (s.aiJob?.controller === controller ? { aiJob: { ...s.aiJob, progress } } : {})),
  };
  let results: Candidate[];
  try {
    const { doc, frameId, ai } = pixel;
    const count = Math.min(input.count, caps.maxCount);
    results =
      input.kind === "create"
        ? await createSprite(doc, { ...ai.create, prompt: input.prompt, count }, ctx)
        : input.kind === "vary"
          ? await varySprite(doc, frameId, { ...ai.vary, prompt: input.prompt, count }, ctx)
          : await editRegion(doc, frameId, { ...ai.edit, prompt: input.prompt, region: region! }, ctx);
  } finally {
    signal.removeEventListener("abort", onAbort);
    usePixel.setState((s) => (s.aiJob?.controller === controller ? { aiJob: null } : {}));
  }
  usePixel.getState().addCandidates(results);

  const { doc, frameId } = usePixel.getState();
  const background = keyColorFor(doc.palette.map(hexToPacked));
  const ids = results.map((c) => {
    const id = `r${resultIds.size + 1}`;
    resultIds.set(id, c.id);
    return id;
  });
  const images = await Promise.all(
    results.map((c) => {
      // Edit results are shown in place, as they would look applied.
      const pixels = c.region ? pasteRegion(D.composite(doc, frameId), c.pixels, doc.width, c.region) : c.pixels;
      return renderPixels(pixels, c.width, c.height, viewScale(doc), background);
    }),
  );
  return {
    output: {
      text: `Made ${ids.join(", ")}; images follow in that order, with transparency shown as solid ${packedToHex(background)}. Place one with apply_result (as "${
        input.kind === "edit" ? "area" : "layer"
      }" fits best), or ignore them. They also appear in the Image tools tab.`,
      summary: `Generated ${ids.length === 1 ? "an image" : `${ids.length} images`} with ${connection.name}`,
    },
    images,
  };
}

function applyResult(raw: unknown): Outcome {
  const parsed = parseToolInput(ApplyInput, raw);
  if ("error" in parsed) return { output: toolError("apply_result", parsed.error), images: [] };
  const { result, as } = parsed.data;
  const id = resultIds.get(result) ?? result;
  if (!usePixel.getState().candidates.some((c) => c.id === id)) {
    return { output: toolError("apply_result", `There is no result ${result}; it may have been dismissed.`), images: [] };
  }
  const target: ApplyTarget = as === "area" ? "region" : as;
  const problem = usePixel.getState().applyCandidate(id, target);
  if (problem) return { output: toolError("apply_result", problem), images: [] };
  const where = { layer: "as a new layer", frame: "as a new frame", replace: "over the current layer", area: "in the edited area" }[as];
  return {
    output: { text: `Placed ${result} ${where}. ${editorSummary(usePixel.getState())}`, summary: `Placed ${result} ${where}` },
    images: [],
  };
}

async function runTool(call: ToolCall, signal: AbortSignal, imageTools: boolean): Promise<Outcome> {
  if (imageTools && call.name === GENERATE_SPEC.name) return generateImage(call.input, signal);
  if (imageTools && call.name === APPLY_SPEC.name) return applyResult(call.input);
  const tool = EDIT_TOOLS.find((t) => t.name === call.name);
  if (!tool) return { output: toolError(call.name, `There is no tool called ${call.name}.`), images: [] };

  const s = usePixel.getState();
  const state: EditorState = { doc: s.doc, layerId: s.layerId, frameId: s.frameId, selection: s.selection };
  const output = tool.run(call.input, state);
  if (output.state) {
    if (output.replaced) s.replaceDoc(output.state.doc);
    else {
      if (output.state.doc !== s.doc) s.commit(output.state.doc);
      usePixel.setState({ layerId: output.state.layerId, frameId: output.state.frameId });
    }
  }
  const images: ChatImage[] = [];
  if (output.view) {
    const { doc } = usePixel.getState();
    const v = output.view;
    const pixels = v.layerId ? D.celPixels(doc, v.layerId, v.frameId) : D.composite(doc, v.frameId);
    images.push(await renderPixels(pixels, doc.width, doc.height, v.scale, v.background));
  }
  return { output, images };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const useAgent = create<AgentState>()((set, get) => {
  const push = (entry: AgentEntry) => set((s) => ({ entries: [...s.entries, entry] }));
  const patch = (id: string, change: Partial<AgentEntry>) =>
    set((s) => ({ entries: s.entries.map((e) => (e.id === id ? ({ ...e, ...change } as AgentEntry) : e)) }));
  const append = (turn: ChatTurn) => set((s) => ({ turns: [...s.turns, turn] }));

  return {
    entries: [],
    turns: [],
    running: false,
    controller: null,

    async send(text) {
      const message = text.trim();
      if (!message || get().running) return;
      const assistant = assistantFor(useApp.getState());
      push({ id: crypto.randomUUID(), kind: "user", text: message });
      if (!assistant) {
        push({ id: crypto.randomUUID(), kind: "error", text: "Add a Claude or OpenRouter connection first." });
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      set({ running: true, controller });

      const pixel = usePixel.getState();
      append({ role: "user", text: `<editor>${editorSummary(pixel)}</editor>\n\n${message}` });
      const imageTools = activeConnection(useApp.getState()) !== null;
      const tools = [...EDIT_TOOLS.map((t) => t.spec), ...(imageTools ? [GENERATE_SPEC, APPLY_SPEC] : [])];
      const system = imageTools ? SYSTEM + IMAGE_NOTE : SYSTEM;

      pixel.beginBatch();
      try {
        const config = await assistantConfig(assistant);
        let step = 0;
        for (; step < MAX_STEPS && !signal.aborted; step++) {
          const entryId = crypto.randomUUID();
          let streamed = "";
          push({ id: entryId, kind: "assistant", text: "", done: false });
          const reply = await assistant.chat.send(
            {
              model: assistant.model,
              system,
              turns: get().turns,
              tools,
              effort: "high",
              signal,
              onText: (delta) => {
                streamed += delta;
                patch(entryId, { text: streamed });
              },
              onRestart: () => {
                streamed = "";
                patch(entryId, { text: "" });
              },
            },
            config,
          );
          append(reply.turn);
          if (reply.turn.text.trim()) patch(entryId, { text: reply.turn.text, done: true });
          else set((s) => ({ entries: s.entries.filter((e) => e.id !== entryId) }));

          const calls = reply.turn.toolCalls;
          // Tool calls in a cut-off or declined reply may be incomplete, so they are
          // answered without running; the conversation stays valid for the next message.
          const problem =
            reply.stop === "refusal"
              ? `${reply.model} declined this request.`
              : reply.stop === "max_tokens"
                ? "The reply was cut off before it finished."
                : null;
          if (problem) {
            if (calls.length) append({ role: "tool", results: calls.map((c) => ({ id: c.id, text: `Not run: ${problem}`, isError: true })) });
            push({ id: crypto.randomUUID(), kind: "error", text: problem });
            break;
          }
          if (!calls.length) break;

          const results: ToolResult[] = [];
          for (const call of calls) {
            if (signal.aborted) {
              results.push({ id: call.id, text: "Not run: the user stopped the assistant.", isError: true });
              continue;
            }
            try {
              const { output, images } = await runTool(call, signal, imageTools);
              results.push({ id: call.id, text: output.text, images, isError: output.isError });
              push({ id: crypto.randomUUID(), kind: "tool", text: output.summary, error: output.isError });
            } catch (err) {
              const stopped = signal.aborted || isAbortError(err);
              const textOut = stopped ? "Stopped by the user." : errorText(err);
              results.push({ id: call.id, text: textOut, isError: true });
              push({ id: crypto.randomUUID(), kind: "tool", text: `${call.name}: ${textOut}`, error: true });
            }
          }
          append({ role: "tool", results });
        }
        if (step >= MAX_STEPS) {
          push({ id: crypto.randomUUID(), kind: "note", text: `Stopped after ${MAX_STEPS} steps. Send another message to continue.` });
        }
        if (signal.aborted) push({ id: crypto.randomUUID(), kind: "note", text: "Stopped." });
      } catch (err) {
        set((s) => ({ entries: s.entries.filter((e) => !(e.kind === "assistant" && !e.done && !e.text)) }));
        if (signal.aborted || isAbortError(err)) push({ id: crypto.randomUUID(), kind: "note", text: "Stopped." });
        else push({ id: crypto.randomUUID(), kind: "error", text: errorText(err) });
      } finally {
        usePixel.getState().endBatch();
        set((s) => ({
          running: false,
          controller: null,
          entries: s.entries.map((e) => (e.kind === "assistant" && !e.done ? { ...e, done: true } : e)),
        }));
      }
    },

    stop() {
      get().controller?.abort();
    },

    reset() {
      if (get().running) return;
      resultIds.clear();
      set({ entries: [], turns: [] });
    },
  };
});
