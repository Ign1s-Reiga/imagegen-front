"use client";

import { create } from "zustand";

import { imageDimensions, sniffImageMime } from "@/lib/bytes";
import {
  deleteGeneration,
  deleteImage,
  listGenerations,
  readImageBytes,
  saveGeneration,
  setFavorite,
  type GenerationRecord,
  type ImageRecord,
} from "@/lib/gallery";
import { isAbortError } from "@/lib/http";
import { normalizeMask } from "@/lib/mask";
import { deleteConnectionSecrets, deleteSecret, resolveConfig, setSecret } from "@/lib/secrets";
import { loadSettings, saveSetting, type PersistedForm } from "@/lib/settings";
import {
  boundInput,
  detectBindings,
  parseWorkflowJson,
  workflowDefaults,
  type SavedWorkflow,
} from "@/providers/comfy-workflow";
import { provider } from "@/providers/registry";
import type {
  Capabilities,
  Connection,
  GenerateParams,
  InputImage,
  Mode,
  ModelChoice,
  Progress,
} from "@/providers/types";

export interface FormState extends PersistedForm {
  mode: Mode;
  initImage: InputImage | null;
  mask: InputImage | null;
}

export interface Job {
  status: "running" | "error";
  startedAt: number;
  progress?: Progress;
  error?: string;
  controller?: AbortController;
}

interface Choices {
  models?: ModelChoice[];
  samplers?: string[];
  schedulers?: string[];
  /** Combo choices for workflow inputs, keyed "ClassType.input". */
  inputs?: Record<string, string[]>;
  loading?: boolean;
  error?: string;
}

/** Fields remembered per connection; everything else is shared. */
const PER_CONNECTION = ["model", "steps", "cfg", "sampler", "scheduler", "options"] as const;
const GLOBAL_KEY = "_global";

const BASE_FORM: FormState = {
  prompt: "",
  negativePrompt: "",
  model: "",
  width: 1024,
  height: 1024,
  count: 1,
  seed: null,
  steps: 25,
  cfg: 7,
  sampler: "",
  scheduler: "",
  strength: 0.6,
  options: {},
  mode: "txt2img",
  initImage: null,
  mask: null,
};

interface AppState {
  ready: boolean;
  connections: Connection[];
  activeConnectionId: string | null;
  forms: Record<string, Partial<PersistedForm>>;
  form: FormState;
  workflows: SavedWorkflow[];
  job: Job | null;
  recent: GenerationRecord[];
  selection: { generationId: string; imageIndex: number } | null;
  choices: Record<string, Choices>;
  /** Bumped whenever the gallery contents change. */
  galleryVersion: number;
  notice: string | null;

  init(): Promise<void>;
  setForm(patch: Partial<FormState>): void;
  selectConnection(id: string): void;
  saveConnection(connection: Connection, secrets: Record<string, string | null>): Promise<void>;
  removeConnection(id: string): Promise<void>;
  loadChoices(connectionId: string): Promise<void>;
  importWorkflow(file: File): Promise<SavedWorkflow | null>;
  saveWorkflow(workflow: SavedWorkflow): Promise<void>;
  deleteWorkflow(id: string): Promise<void>;
  selectWorkflow(id: string | null): void;
  generate(): Promise<void>;
  cancel(): void;
  dismissJob(): void;
  select(generation: GenerationRecord, imageIndex?: number): void;
  reuseSettings(generation: GenerationRecord): void;
  loadAsInput(image: ImageRecord): Promise<void>;
  setInputFromFile(file: File, target: "initImage" | "mask"): Promise<void>;
  toggleFavorite(image: ImageRecord): Promise<void>;
  removeImage(image: ImageRecord): Promise<void>;
  removeGeneration(generation: GenerationRecord): Promise<void>;
  notify(message: string | null): void;
}

type Selectable = Pick<AppState, "connections" | "activeConnectionId" | "workflows" | "form">;

export const activeConnection = (s: Pick<AppState, "connections" | "activeConnectionId">) =>
  s.connections.find((c) => c.id === s.activeConnectionId) ?? null;

/** The imported workflow selected for the active connection, if any. */
export const activeWorkflow = (s: Selectable) => {
  const connection = activeConnection(s);
  if (!connection || !provider(connection.kind).supportsWorkflows) return null;
  const id = s.form.options.workflow;
  return id ? (s.workflows.find((w) => w.id === id) ?? null) : null;
};

export function capabilitiesFor(connection: Connection | null, workflow: SavedWorkflow | null): Capabilities | null {
  return connection ? provider(connection.kind).capabilities(connection.config, workflow) : null;
}

/** The mode a generation will actually run in. */
export function effectiveMode(form: Pick<FormState, "mode">, caps: Capabilities): Mode {
  if (caps.img2imgOnly) return "img2img";
  return caps.img2img ? form.mode : "txt2img";
}

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

const roundTo = (value: number, step: number) => Math.max(step, Math.round(value / step) * step);

/** Output size matching an input image, snapped to what the backend accepts. */
const outputSizeFor = (width: number, height: number, caps: Capabilities | null) => {
  const step = caps?.sizeStep ?? 8;
  return { width: roundTo(width, step), height: roundTo(height, step) };
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const defined = <T extends object>(obj: T) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/** Form for a connection: base, then provider defaults, then what was last used. */
function formFor(
  connection: Connection | null,
  forms: Record<string, Partial<PersistedForm>>,
  current: FormState,
): FormState {
  const shared = { ...current };
  if (!connection) return shared;
  const def = provider(connection.kind);
  const optionDefaults = Object.fromEntries(def.options.map((o) => [o.key, o.default]));
  const saved = forms[connection.id] ?? {};
  return {
    ...shared,
    model: "",
    steps: def.defaults?.steps ?? BASE_FORM.steps,
    cfg: def.defaults?.cfg ?? BASE_FORM.cfg,
    sampler: def.defaults?.sampler ?? "",
    scheduler: def.defaults?.scheduler ?? "",
    ...saved,
    options: { ...optionDefaults, ...saved.options },
  };
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

export const useApp = create<AppState>()((set, get) => {
  /** Writes the current form into `forms` (shared part + active connection). */
  const flushForm = () => {
    clearTimeout(persistTimer);
    const { form, forms, activeConnectionId } = get();
    const next = { ...forms };
    next[GLOBAL_KEY] = {
      prompt: form.prompt,
      negativePrompt: form.negativePrompt,
      width: form.width,
      height: form.height,
      count: form.count,
      seed: form.seed,
      strength: form.strength,
    };
    if (activeConnectionId) {
      next[activeConnectionId] = Object.fromEntries(PER_CONNECTION.map((k) => [k, form[k]]));
    }
    set({ forms: next });
    void saveSetting("forms", next);
    return next;
  };

  const persistForm = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flushForm, 500);
  };

  /** Loads combo choices for the inputs an imported workflow exposes. */
  const loadWorkflowChoices = async (connection: Connection, workflow: SavedWorkflow) => {
    const def = provider(connection.kind);
    if (!def.listInputChoices) return;
    const wanted = workflow.bindings
      .filter((b) => b.target === "field")
      .map((b) => ({ classType: workflow.graph[b.nodeId]?.class_type, input: b.input }))
      .filter((i): i is { classType: string; input: string } => Boolean(i.classType));
    const model = boundInput(workflow, "model");
    if (model) wanted.push(model);
    if (!wanted.length) return;
    try {
      const inputs = await def.listInputChoices(await resolveConfig(connection), wanted);
      set((s) => ({
        choices: {
          ...s.choices,
          [connection.id]: { ...s.choices[connection.id], inputs: { ...s.choices[connection.id]?.inputs, ...inputs } },
        },
      }));
    } catch {
      // Inputs fall back to free text.
    }
  };

  return {
    ready: false,
    connections: [],
    activeConnectionId: null,
    forms: {},
    form: BASE_FORM,
    workflows: [],
    job: null,
    recent: [],
    selection: null,
    choices: {},
    galleryVersion: 0,
    notice: null,

    async init() {
      if (get().ready) return;
      const settings = await loadSettings();
      const active =
        settings.connections.find((c) => c.id === settings.activeConnectionId) ?? settings.connections[0] ?? null;
      const base: FormState = { ...BASE_FORM, ...settings.forms[GLOBAL_KEY] };
      const recent = await listGenerations({ limit: 40 }).catch(() => []);
      set({
        ready: true,
        connections: settings.connections,
        activeConnectionId: active?.id ?? null,
        forms: settings.forms,
        form: formFor(active, settings.forms, base),
        workflows: settings.workflows,
        recent,
        selection: recent[0] ? { generationId: recent[0].id, imageIndex: 0 } : null,
      });
      if (active) void get().loadChoices(active.id);
    },

    setForm(patch) {
      set((s) => ({ form: { ...s.form, ...patch } }));
      persistForm();
    },

    selectConnection(id) {
      const connection = get().connections.find((c) => c.id === id) ?? null;
      if (!connection) return;
      const forms = flushForm();
      set({ activeConnectionId: id, form: formFor(connection, forms, get().form) });
      void saveSetting("activeConnectionId", id);
      if (!get().choices[id]?.models) void get().loadChoices(id);
    },

    async saveConnection(connection, secrets) {
      for (const [key, value] of Object.entries(secrets)) {
        if (value === null) await deleteSecret(connection.id, key);
        else if (value) await setSecret(connection.id, key, value);
      }
      const existing = get().connections;
      const connections = existing.some((c) => c.id === connection.id)
        ? existing.map((c) => (c.id === connection.id ? connection : c))
        : [...existing, connection];
      set({ connections, choices: { ...get().choices, [connection.id]: {} } });
      await saveSetting("connections", connections);
      if (!get().activeConnectionId || existing.length === 0) get().selectConnection(connection.id);
      else if (get().activeConnectionId === connection.id) void get().loadChoices(connection.id);
    },

    async removeConnection(id) {
      const connection = get().connections.find((c) => c.id === id);
      if (!connection) return;
      await deleteConnectionSecrets(connection).catch(() => {});
      const connections = get().connections.filter((c) => c.id !== id);
      const forms = { ...get().forms };
      delete forms[id];
      set({ connections, forms });
      await saveSetting("connections", connections);
      await saveSetting("forms", forms);
      if (get().activeConnectionId === id) {
        const next = connections[0];
        if (next) get().selectConnection(next.id);
        else {
          set({ activeConnectionId: null });
          await saveSetting("activeConnectionId", null);
        }
      }
    },

    async loadChoices(connectionId) {
      const connection = get().connections.find((c) => c.id === connectionId);
      if (!connection) return;
      const def = provider(connection.kind);
      const update = (patch: Choices) =>
        set((s) => ({ choices: { ...s.choices, [connectionId]: { ...s.choices[connectionId], ...patch } } }));
      const workflow = get().activeConnectionId === connectionId ? activeWorkflow(get()) : null;
      if (workflow) void loadWorkflowChoices(connection, workflow);
      if (!def.listModels && !def.listSamplers) {
        update({ models: def.suggestedModels.map((value) => ({ value })) });
        return;
      }
      update({ loading: true, error: undefined });
      try {
        const config = await resolveConfig(connection);
        const [models, samplers] = await Promise.all([
          def.listModels?.(config) ?? Promise.resolve(def.suggestedModels.map((value) => ({ value }))),
          def.listSamplers?.(config) ?? Promise.resolve(undefined),
        ]);
        update({ models, samplers: samplers?.samplers, schedulers: samplers?.schedulers, loading: false });
      } catch (err) {
        update({
          models: def.suggestedModels.map((value) => ({ value })),
          loading: false,
          error: errorMessage(err),
        });
      }
    },

    async importWorkflow(file) {
      try {
        const graph = parseWorkflowJson(await file.text());
        const workflow: SavedWorkflow = {
          id: crypto.randomUUID(),
          name: file.name.replace(/\.json$/i, "") || "Imported workflow",
          graph,
          bindings: detectBindings(graph),
          createdAt: Date.now(),
        };
        await get().saveWorkflow(workflow);
        get().selectWorkflow(workflow.id);
        return workflow;
      } catch (err) {
        set({ notice: `Could not import ${file.name}: ${errorMessage(err)}` });
        return null;
      }
    },

    async saveWorkflow(workflow) {
      const existing = get().workflows;
      const workflows = existing.some((w) => w.id === workflow.id)
        ? existing.map((w) => (w.id === workflow.id ? workflow : w))
        : [...existing, workflow];
      set({ workflows });
      await saveSetting("workflows", workflows);
      const connection = activeConnection(get());
      if (connection && get().form.options.workflow === workflow.id) {
        void loadWorkflowChoices(connection, workflow);
      }
    },

    async deleteWorkflow(id) {
      const workflows = get().workflows.filter((w) => w.id !== id);
      set({ workflows });
      await saveSetting("workflows", workflows);
      if (get().form.options.workflow === id) get().selectWorkflow(null);
    },

    selectWorkflow(id) {
      const { form, workflows } = get();
      const workflow = id ? workflows.find((w) => w.id === id) : undefined;
      const connection = activeConnection(get());
      if (!workflow) {
        get().setForm({ options: { ...form.options, workflow: "" } });
        return;
      }
      // Start from the values the workflow was exported with.
      const { options, ...values } = workflowDefaults(workflow);
      const patch: Partial<FormState> = {
        ...defined(values),
        options: { ...form.options, ...options, workflow: workflow.id },
      };
      if (workflow.bindings.some((b) => b.target === "initImage")) patch.mode = "img2img";
      get().setForm(patch);
      if (connection) void loadWorkflowChoices(connection, workflow);
    },

    async generate() {
      const state = get();
      if (state.job?.status === "running") return;
      const fail = (error: string) => set({ job: { status: "error", startedAt: Date.now(), error } });
      const connection = activeConnection(state);
      if (!connection) return fail("Add a connection first.");
      const def = provider(connection.kind);
      const workflow = activeWorkflow(state);
      const caps = def.capabilities(connection.config, workflow);
      const { form } = state;

      if (!form.prompt.trim() && (!workflow || workflow.bindings.some((b) => b.target === "prompt"))) {
        return fail("Write a prompt first.");
      }
      const mode = effectiveMode(form, caps);
      if (mode === "img2img" && !form.initImage) return fail("Add an input image, or switch to text to image.");

      const seed = caps.seed && form.seed !== null ? form.seed : randomSeed();
      const params: GenerateParams = {
        mode,
        prompt: form.prompt.trim(),
        negativePrompt: caps.negativePrompt ? form.negativePrompt.trim() : "",
        model: caps.model ? form.model.trim() : "",
        width: roundTo(form.width, caps.sizeStep),
        height: roundTo(form.height, caps.sizeStep),
        count: Math.min(Math.max(1, form.count), caps.maxCount),
        seed,
        steps: form.steps,
        cfg: form.cfg,
        sampler: form.sampler,
        scheduler: form.scheduler,
        strength: form.strength,
        initImage: mode === "img2img" ? form.initImage : null,
        mask: mode === "img2img" && caps.mask ? form.mask : null,
        options: form.options,
        workflow,
      };

      const controller = new AbortController();
      const startedAt = Date.now();
      set({
        job: { status: "running", startedAt, controller, progress: { stage: "queued", message: "Starting" } },
      });

      try {
        const config = await resolveConfig(connection);
        const missing = def.fields.filter((f) => f.required && !config[f.key]?.trim());
        if (missing.length) {
          throw new Error(
            `${connection.name} needs ${missing.map((f) => f.label.toLowerCase()).join(" and ")}. Add it in Connections.`,
          );
        }
        const result = await def.generate(params, config, {
          signal: controller.signal,
          onProgress: (progress) =>
            set((s) => (s.job?.controller === controller ? { job: { ...s.job, progress } } : {})),
        });
        if (controller.signal.aborted) throw new DOMException("canceled", "AbortError");

        const record = await saveGeneration(
          {
            id: crypto.randomUUID(),
            createdAt: startedAt,
            provider: connection.kind,
            connectionName: connection.name,
            model: result.model || params.model || (workflow ? workflow.name : def.defaultModel(config)) || null,
            mode,
            prompt: params.prompt,
            negativePrompt: params.negativePrompt || null,
            params: {
              width: params.width,
              height: params.height,
              count: params.count,
              seed: params.seed,
              steps: params.steps,
              cfg: params.cfg,
              sampler: params.sampler,
              scheduler: params.scheduler,
              strength: params.strength,
              options: params.options,
              connectionId: connection.id,
              info: { ...result.info, ...(workflow ? { workflow: workflow.name } : {}) },
            },
            durationMs: Date.now() - startedAt,
          },
          result.images,
        );
        set((s) => ({
          job: null,
          recent: [record, ...s.recent],
          selection: { generationId: record.id, imageIndex: 0 },
          galleryVersion: s.galleryVersion + 1,
        }));
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          set((s) => (s.job?.controller === controller ? { job: null } : {}));
        } else {
          set((s) =>
            s.job?.controller === controller
              ? { job: { status: "error", startedAt, error: errorMessage(err) } }
              : {},
          );
        }
      }
    },

    cancel() {
      get().job?.controller?.abort();
      set({ job: null });
    },

    dismissJob() {
      if (get().job?.status === "error") set({ job: null });
    },

    select(generation, imageIndex = 0) {
      set((s) => {
        // Generations opened from the gallery join the strip in date order.
        const recent = s.recent.some((g) => g.id === generation.id)
          ? s.recent
          : [...s.recent, generation].sort((a, b) => b.createdAt - a.createdAt);
        return { recent, selection: { generationId: generation.id, imageIndex } };
      });
    },

    reuseSettings(generation) {
      const { connections } = get();
      const p = generation.params;
      if (p.connectionId && connections.some((c) => c.id === p.connectionId)) {
        get().selectConnection(p.connectionId);
      }
      get().setForm({
        prompt: generation.prompt,
        negativePrompt: generation.negativePrompt ?? "",
        mode: generation.mode,
        model: generation.model ?? "",
        width: p.width,
        height: p.height,
        count: p.count,
        seed: p.seed,
        steps: p.steps,
        cfg: p.cfg,
        sampler: p.sampler,
        scheduler: p.scheduler,
        strength: p.strength,
        options: { ...get().form.options, ...p.options },
      });
      set({ notice: "Settings loaded. The seed is fixed; clear it for new variations." });
    },

    async loadAsInput(image) {
      const bytes = await readImageBytes(image.id);
      const width = image.width ?? 1024;
      const height = image.height ?? 1024;
      const caps = capabilitiesFor(activeConnection(get()), activeWorkflow(get()));
      get().setForm({
        mode: "img2img",
        initImage: { bytes, mime: image.mime, name: image.fileName, width, height },
        mask: null,
        ...outputSizeFor(width, height, caps),
      });
    },

    async setInputFromFile(file, target) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = sniffImageMime(bytes, file.type);
      const size = await imageDimensions(bytes, mime);
      if (!size) {
        set({ notice: `${file.name} is not an image this app can read.` });
        return;
      }
      if (target === "initImage") {
        const caps = capabilitiesFor(activeConnection(get()), activeWorkflow(get()));
        get().setForm({
          initImage: { bytes, mime, name: file.name, ...size },
          // A mask only fits the image it was made for.
          mask: null,
          mode: "img2img",
          ...outputSizeFor(size.width, size.height, caps),
        });
        return;
      }
      const init = get().form.initImage;
      if (!init) {
        set({ notice: "Add the input image first; the mask is matched to its size." });
        return;
      }
      const mask = await normalizeMask(bytes, mime, init.width, init.height);
      get().setForm({ mask: { ...mask, name: file.name } });
    },

    async toggleFavorite(image) {
      const favorite = !image.favorite;
      await setFavorite(image.id, favorite);
      set((s) => ({
        recent: s.recent.map((g) =>
          g.id === image.generationId
            ? { ...g, images: g.images.map((i) => (i.id === image.id ? { ...i, favorite } : i)) }
            : g,
        ),
        galleryVersion: s.galleryVersion + 1,
      }));
    },

    async removeImage(image) {
      await deleteImage(image.id);
      set((s) => {
        const recent = s.recent
          .map((g) => (g.id === image.generationId ? { ...g, images: g.images.filter((i) => i.id !== image.id) } : g))
          .filter((g) => g.images.length > 0);
        const selection =
          s.selection?.generationId === image.generationId
            ? recent.some((g) => g.id === image.generationId)
              ? { generationId: image.generationId, imageIndex: 0 }
              : recent[0]
                ? { generationId: recent[0].id, imageIndex: 0 }
                : null
            : s.selection;
        return { recent, selection, galleryVersion: s.galleryVersion + 1 };
      });
    },

    async removeGeneration(generation) {
      await deleteGeneration(generation.id);
      set((s) => {
        const recent = s.recent.filter((g) => g.id !== generation.id);
        const selection =
          s.selection?.generationId === generation.id
            ? recent[0]
              ? { generationId: recent[0].id, imageIndex: 0 }
              : null
            : s.selection;
        return { recent, selection, galleryVersion: s.galleryVersion + 1 };
      });
    },

    notify(message) {
      set({ notice: message });
    },
  };
});
