"use client";

import { load, type Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";

import { isAbortError } from "@/lib/http";
import type { Progress } from "@/providers/types";

import { createSprite, editRegion, varySprite, type AiOp, type Candidate } from "./ai.ts";
import { PALETTE_PRESETS, packedToHex, usedColors } from "./color.ts";
import * as D from "./doc.ts";
import { clampRect, clearRect, pasteRegion, type Mirror, type Rect } from "./raster.ts";

export type Tool = "pencil" | "eraser" | "fill" | "picker" | "line" | "rect" | "select" | "move";

export const ZOOM_LEVELS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
export const MAX_BRUSH = 8;
const HISTORY_LIMIT = 200;
const MAX_CANDIDATES = 24;
/** Edits with the same coalesce key this close together form one undo step. */
const COALESCE_MS = 1000;

export interface AiJob {
  op: AiOp;
  startedAt: number;
  progress?: Progress;
  controller: AbortController;
}

export interface AiSettings {
  create: { prompt: string; count: number; keepPalette: boolean; colors: number; removeBackground: boolean };
  edit: { prompt: string; strength: number };
  vary: { prompt: string; count: number; strength: number; keepPalette: boolean; colors: number };
}

export type ApplyTarget = "layer" | "frame" | "replace" | "region";

/** The AI panel shows the assistant chat or the image tools. */
export type AiPanelTab = "assistant" | "tools";

interface PixelState {
  loaded: boolean;
  doc: D.PixelDoc;
  past: D.PixelDoc[];
  future: D.PixelDoc[];
  layerId: string;
  frameId: string;
  /** Unsaved changes since the sprite was last saved to or opened from a file. */
  dirty: boolean;
  tool: Tool;
  brushSize: number;
  mirror: Mirror;
  shapeFill: boolean;
  primary: string;
  secondary: string;
  selection: Rect | null;
  zoom: number;
  pan: { x: number; y: number };
  /** Bumped to ask the canvas to fit the sprite into view. */
  fitRequest: number;
  showGrid: boolean;
  onion: boolean;
  playing: boolean;
  hover: { x: number; y: number } | null;

  aiPanel: AiPanelTab;
  aiTab: AiOp;
  ai: AiSettings;
  aiJob: AiJob | null;
  aiError: string | null;
  candidates: Candidate[];

  load(): Promise<void>;
  /** Replaces the sprite; undo brings the previous one back. */
  replaceDoc(doc: D.PixelDoc): void;
  commit(doc: D.PixelDoc, coalesce?: string): void;
  /** Until endBatch, every commit joins one undo step (the assistant's edits for one message). */
  beginBatch(): void;
  endBatch(): void;
  undo(): void;
  redo(): void;
  markSaved(): void;
  rename(name: string): void;

  setTool(tool: Tool): void;
  setBrushSize(size: number): void;
  toggleMirror(axis: keyof Mirror): void;
  setShapeFill(filled: boolean): void;
  setPrimary(hex: string): void;
  setSecondary(hex: string): void;
  swapColors(): void;
  setSelection(rect: Rect | null): void;
  selectAll(): void;
  clearPixels(): void;

  selectLayer(id: string): void;
  addLayer(): void;
  duplicateLayer(): void;
  removeLayer(id: string): void;
  moveLayer(id: string, delta: number): void;
  mergeDown(id: string): void;
  updateLayer(id: string, patch: Partial<Omit<D.Layer, "id">>, coalesce?: boolean): void;

  selectFrame(id: string): void;
  addFrame(): void;
  duplicateFrame(): void;
  removeFrame(id: string): void;
  moveFrame(id: string, delta: number): void;
  setFps(fps: number): void;
  togglePlaying(): void;
  setPlaying(playing: boolean): void;
  toggleOnion(): void;

  setPalette(colors: string[]): void;
  addColor(hex: string): void;
  removeColor(index: number): void;
  replaceColor(index: number, hex: string): void;
  addUsedColors(): void;

  setZoom(zoom: number): void;
  setView(zoom: number, pan: { x: number; y: number }): void;
  fit(): void;
  toggleGrid(): void;
  setHover(hover: { x: number; y: number } | null): void;

  setAiPanel(tab: AiPanelTab): void;
  setAiTab(tab: AiOp): void;
  setAi<K extends AiOp>(op: K, patch: Partial<AiSettings[K]>): void;
  runAi(): Promise<void>;
  cancelAi(): void;
  dismissAiError(): void;
  addCandidates(results: Candidate[]): void;
  applyCandidate(id: string, target: ApplyTarget): string | null;
  dismissCandidate(id: string): void;
}

const DEFAULT_AI: AiSettings = {
  create: { prompt: "", count: 2, keepPalette: true, colors: 16, removeBackground: true },
  edit: { prompt: "", strength: 0.6 },
  vary: { prompt: "", count: 2, strength: 0.55, keepPalette: true, colors: 16 },
};

let storePromise: Promise<Store> | null = null;
const persisted = () => (storePromise ??= load("pixel.json", { defaults: {}, autoSave: 500 }));

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let lastCoalesce: { key: string; at: number } | null = null;
/** Open undo batch; `pushed` once the batch's undo step exists. */
let batch: { pushed: boolean } | null = null;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Keeps the current layer, frame and selection valid for a (new) document. */
function cursorFor(doc: D.PixelDoc, state: Pick<PixelState, "layerId" | "frameId" | "selection">) {
  return {
    layerId: doc.layers.some((l) => l.id === state.layerId) ? state.layerId : doc.layers[doc.layers.length - 1].id,
    frameId: doc.frames.some((f) => f.id === state.frameId) ? state.frameId : doc.frames[0].id,
    selection: state.selection ? clampRect(state.selection, doc.width, doc.height) : null,
  };
}

export const usePixel = create<PixelState>()((set, get) => {
  const initial = D.createDoc({ width: 32, height: 32 });

  const scheduleAutosave = () => {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try {
        await (await persisted()).set("doc", D.toFile(get().doc));
      } catch {
        // Autosave is best effort; saving to a file still works.
      }
    }, 600);
  };

  const current = () => {
    const { doc, layerId, frameId } = get();
    return D.celPixels(doc, layerId, frameId);
  };

  const commitCel = (pixels: Uint32Array) => {
    const { doc, layerId, frameId } = get();
    get().commit(D.withCel(doc, layerId, frameId, pixels));
  };

  return {
    loaded: false,
    doc: initial,
    past: [],
    future: [],
    layerId: initial.layers[0].id,
    frameId: initial.frames[0].id,
    dirty: false,
    tool: "pencil",
    brushSize: 1,
    mirror: { x: false, y: false },
    shapeFill: false,
    primary: initial.palette[0],
    secondary: initial.palette[initial.palette.length - 4] ?? "#ffffff",
    selection: null,
    zoom: 12,
    pan: { x: 0, y: 0 },
    fitRequest: 0,
    showGrid: true,
    onion: false,
    playing: false,
    hover: null,

    aiPanel: "assistant",
    aiTab: "create",
    ai: DEFAULT_AI,
    aiJob: null,
    aiError: null,
    candidates: [],

    async load() {
      if (get().loaded) return;
      try {
        const saved = await (await persisted()).get<unknown>("doc");
        if (saved) {
          const doc = D.fromFile(saved);
          set({ doc, ...cursorFor(doc, get()), primary: doc.palette[0] ?? get().primary });
        }
      } catch {
        // A damaged autosave is replaced by a fresh sprite.
      }
      set((s) => ({ loaded: true, fitRequest: s.fitRequest + 1 }));
    },

    replaceDoc(doc) {
      get().commit(doc);
      set((s) => ({
        layerId: doc.layers[doc.layers.length - 1].id,
        frameId: doc.frames[0].id,
        selection: null,
        dirty: false,
        playing: false,
        primary: doc.palette[0] ?? s.primary,
        fitRequest: s.fitRequest + 1,
      }));
    },

    commit(doc, coalesce) {
      const state = get();
      if (doc === state.doc) return;
      const now = Date.now();
      let merge = coalesce !== undefined && lastCoalesce?.key === coalesce && now - lastCoalesce.at < COALESCE_MS;
      lastCoalesce = coalesce !== undefined ? { key: coalesce, at: now } : null;
      if (batch) {
        merge = batch.pushed;
        batch.pushed = true;
      }
      set({
        doc,
        past: merge ? state.past : [...state.past.slice(-(HISTORY_LIMIT - 1)), state.doc],
        future: [],
        dirty: true,
        ...cursorFor(doc, state),
      });
      scheduleAutosave();
    },

    beginBatch() {
      batch = { pushed: false };
      lastCoalesce = null;
    },

    endBatch() {
      batch = null;
      lastCoalesce = null;
    },

    undo() {
      const { past, doc, future } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      lastCoalesce = null;
      // Edits after an undo start a new step, so the undone state stays reachable.
      if (batch) batch.pushed = false;
      set((s) => ({ doc: previous, past: past.slice(0, -1), future: [doc, ...future], dirty: true, ...cursorFor(previous, s) }));
      scheduleAutosave();
    },

    redo() {
      const { past, doc, future } = get();
      const next = future[0];
      if (!next) return;
      lastCoalesce = null;
      if (batch) batch.pushed = false;
      set((s) => ({ doc: next, past: [...past, doc], future: future.slice(1), dirty: true, ...cursorFor(next, s) }));
      scheduleAutosave();
    },

    markSaved() {
      set({ dirty: false });
    },

    rename(name) {
      const trimmed = name.trim();
      if (trimmed && trimmed !== get().doc.name) get().commit({ ...get().doc, name: trimmed });
    },

    setTool(tool) {
      set({ tool });
    },
    setBrushSize(size) {
      set({ brushSize: Math.max(1, Math.min(MAX_BRUSH, Math.round(size))) });
    },
    toggleMirror(axis) {
      set((s) => ({ mirror: { ...s.mirror, [axis]: !s.mirror[axis] } }));
    },
    setShapeFill(shapeFill) {
      set({ shapeFill });
    },
    setPrimary(primary) {
      set({ primary });
    },
    setSecondary(secondary) {
      set({ secondary });
    },
    swapColors() {
      set((s) => ({ primary: s.secondary, secondary: s.primary }));
    },
    setSelection(rect) {
      const { doc } = get();
      set({ selection: rect ? clampRect(rect, doc.width, doc.height) : null });
    },
    selectAll() {
      const { doc } = get();
      set({ selection: { x: 0, y: 0, w: doc.width, h: doc.height } });
    },
    clearPixels() {
      const { selection, doc } = get();
      const pixels = current().slice();
      clearRect(pixels, doc.width, selection ?? { x: 0, y: 0, w: doc.width, h: doc.height });
      commitCel(pixels);
    },

    selectLayer(layerId) {
      set({ layerId });
    },
    addLayer() {
      const { doc, layerId } = get();
      if (doc.layers.length >= D.MAX_LAYERS) return;
      const added = D.addLayer(doc, doc.layers.findIndex((l) => l.id === layerId));
      get().commit(added.doc);
      set({ layerId: added.id });
    },
    duplicateLayer() {
      const { doc, layerId } = get();
      if (doc.layers.length >= D.MAX_LAYERS) return;
      const copy = D.duplicateLayer(doc, layerId);
      get().commit(copy.doc);
      set({ layerId: copy.id });
    },
    removeLayer(id) {
      const { doc } = get();
      const index = doc.layers.findIndex((l) => l.id === id);
      const next = D.removeLayer(doc, id);
      get().commit(next);
      if (get().layerId === id || !next.layers.some((l) => l.id === get().layerId)) {
        set({ layerId: next.layers[Math.max(0, index - 1)].id });
      }
    },
    moveLayer(id, delta) {
      get().commit(D.moveLayer(get().doc, id, delta));
    },
    mergeDown(id) {
      const { doc } = get();
      const index = doc.layers.findIndex((l) => l.id === id);
      if (index <= 0) return;
      const below = doc.layers[index - 1].id;
      get().commit(D.mergeDown(doc, id));
      set({ layerId: below });
    },
    updateLayer(id, patch, coalesce = false) {
      get().commit(D.updateLayer(get().doc, id, patch), coalesce ? `layer:${id}:${Object.keys(patch).join()}` : undefined);
    },

    selectFrame(frameId) {
      set({ frameId });
    },
    addFrame() {
      const { doc, frameId } = get();
      if (doc.frames.length >= D.MAX_FRAMES) return;
      const added = D.addFrame(doc, doc.frames.findIndex((f) => f.id === frameId));
      get().commit(added.doc);
      set({ frameId: added.id });
    },
    duplicateFrame() {
      const { doc, frameId } = get();
      if (doc.frames.length >= D.MAX_FRAMES) return;
      const copy = D.duplicateFrame(doc, frameId);
      get().commit(copy.doc);
      set({ frameId: copy.id });
    },
    removeFrame(id) {
      const { doc } = get();
      const index = doc.frames.findIndex((f) => f.id === id);
      const next = D.removeFrame(doc, id);
      get().commit(next);
      if (get().frameId === id || !next.frames.some((f) => f.id === get().frameId)) {
        set({ frameId: next.frames[Math.max(0, index - 1)].id });
      }
    },
    moveFrame(id, delta) {
      get().commit(D.moveFrame(get().doc, id, delta));
    },
    setFps(fps) {
      get().commit({ ...get().doc, fps: Math.max(1, Math.min(30, Math.round(fps))) }, "fps");
    },
    togglePlaying() {
      set((s) => ({ playing: !s.playing && s.doc.frames.length > 1 }));
    },
    setPlaying(playing) {
      set({ playing });
    },
    toggleOnion() {
      set((s) => ({ onion: !s.onion }));
    },

    setPalette(colors) {
      get().commit({ ...get().doc, palette: [...new Set(colors.map((c) => c.toLowerCase()))].slice(0, 256) });
    },
    addColor(hex) {
      const { doc } = get();
      const color = hex.toLowerCase();
      if (!doc.palette.includes(color)) get().setPalette([...doc.palette, color]);
    },
    removeColor(index) {
      const palette = [...get().doc.palette];
      palette.splice(index, 1);
      get().setPalette(palette);
    },
    replaceColor(index, hex) {
      const { doc } = get();
      const palette = [...doc.palette];
      palette[index] = hex.toLowerCase();
      get().commit({ ...doc, palette }, `palette:${index}`);
    },
    addUsedColors() {
      const { doc } = get();
      const used = usedColors(Object.values(doc.cels)).map(packedToHex);
      get().setPalette([...doc.palette, ...used]);
    },

    setZoom(zoom) {
      set({ zoom: Math.max(ZOOM_LEVELS[0], Math.min(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], zoom)) });
    },
    setView(zoom, pan) {
      set({ zoom, pan });
    },
    fit() {
      set((s) => ({ fitRequest: s.fitRequest + 1 }));
    },
    toggleGrid() {
      set((s) => ({ showGrid: !s.showGrid }));
    },
    setHover(hover) {
      const prev = get().hover;
      if (prev?.x === hover?.x && prev?.y === hover?.y) return;
      set({ hover });
    },

    setAiPanel(aiPanel) {
      set({ aiPanel });
    },
    setAiTab(aiTab) {
      set({ aiTab, aiError: null });
    },
    setAi(op, patch) {
      set((s) => ({ ai: { ...s.ai, [op]: { ...s.ai[op], ...patch } } }));
    },

    async runAi() {
      const state = get();
      if (state.aiJob) return;
      const op = state.aiTab;
      if (op === "edit" && !state.selection) {
        set({ aiError: "Select the area to change first (selection tool, M)." });
        return;
      }
      const controller = new AbortController();
      const job: AiJob = { op, startedAt: Date.now(), controller, progress: { stage: "queued", message: "Starting" } };
      set({ aiJob: job, aiError: null });
      const ctx = {
        signal: controller.signal,
        onProgress: (progress: Progress) => set((s) => (s.aiJob === job ? { aiJob: { ...job, progress } } : {})),
      };
      try {
        const { doc, frameId, ai, selection } = state;
        const results =
          op === "create"
            ? await createSprite(doc, ai.create, ctx)
            : op === "edit"
              ? await editRegion(doc, frameId, { ...ai.edit, region: selection! }, ctx)
              : await varySprite(doc, frameId, ai.vary, ctx);
        set({ aiJob: null });
        get().addCandidates(results);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) set((s) => (s.aiJob?.controller === controller ? { aiJob: null } : {}));
        else set((s) => (s.aiJob?.controller === controller ? { aiJob: null, aiError: errorMessage(err) } : {}));
      }
    },

    cancelAi() {
      get().aiJob?.controller.abort();
      set({ aiJob: null });
    },

    dismissAiError() {
      set({ aiError: null });
    },

    addCandidates(results) {
      set((s) => ({ candidates: [...results, ...s.candidates].slice(0, MAX_CANDIDATES) }));
    },

    applyCandidate(id, target) {
      const candidate = get().candidates.find((c) => c.id === id);
      const { doc, layerId, frameId } = get();
      if (!candidate) return null;
      if (candidate.width !== doc.width || candidate.height !== doc.height) {
        return "This result was made for a sprite of a different size.";
      }
      let next = doc;
      if (candidate.newPalette) {
        next = { ...next, palette: [...new Set([...next.palette, ...candidate.newPalette])].slice(0, 256) };
      }
      let select: Partial<PixelState> = {};
      if (target === "layer") {
        if (doc.layers.length >= D.MAX_LAYERS) return `A sprite can have at most ${D.MAX_LAYERS} layers.`;
        const added = D.addLayer(next, next.layers.findIndex((l) => l.id === layerId), aiLayerName(candidate));
        next = D.withCel(added.doc, added.id, frameId, candidate.pixels);
        select = { layerId: added.id };
      } else if (target === "frame") {
        if (doc.frames.length >= D.MAX_FRAMES) return `A sprite can have at most ${D.MAX_FRAMES} frames.`;
        const added = D.addFrame(next, next.frames.findIndex((f) => f.id === frameId));
        next = D.withCel(added.doc, layerId, added.id, candidate.pixels);
        select = { frameId: added.id };
      } else if (target === "replace") {
        next = D.withCel(next, layerId, frameId, candidate.pixels);
      } else {
        const region = candidate.region ?? { x: 0, y: 0, w: doc.width, h: doc.height };
        next = D.withCel(next, layerId, frameId, pasteRegion(D.celPixels(doc, layerId, frameId), candidate.pixels, doc.width, region));
      }
      get().commit(next);
      set(select);
      return null;
    },

    dismissCandidate(id) {
      set((s) => ({ candidates: s.candidates.filter((c) => c.id !== id) }));
    },
  };
});

function aiLayerName(candidate: Candidate) {
  const words = candidate.prompt.split(/\s+/).slice(0, 4).join(" ");
  return words ? `AI: ${words}` : "AI result";
}

/** A new sprite from a preset. */
export function newSprite(width: number, height: number, presetId: string, name?: string) {
  const preset = PALETTE_PRESETS.find((p) => p.id === presetId);
  return D.createDoc({ width, height, palette: preset?.colors ?? [], name });
}

/** A sprite from an image that is already pixel art (one layer, palette from its colours). */
export function spriteFromPixels(pixels: Uint32Array, width: number, height: number, name: string) {
  const doc = D.createDoc({ width, height, palette: usedColors([pixels], 256).map(packedToHex), name });
  return D.withCel(doc, doc.layers[0].id, doc.frames[0].id, pixels);
}
