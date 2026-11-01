"use client";

import { useMemo } from "react";
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
import { midSentence } from "@/lib/text";
import { deleteConnectionSecrets, deleteSecret, resolveConfig, setSecret } from "@/lib/secrets";
import { loadSettings, saveSetting, type AssistantChoice, type PersistedForm } from "@/lib/settings";
import type { ChatModel, ChatService } from "@/providers/chat";
import {
  boundInput,
  detectBindings,
  parseWorkflowJson,
  workflowDefaults,
  type SavedWorkflow,
} from "@/providers/comfy-workflow";
import { chatService, isImageConnection, provider, service } from "@/providers/registry";
import type {
  Capabilities,
  Connection,
  CreditInfo,
  GenerateParams,
  GeneratedImage,
  ImageConnection,
  InputImage,
  Mode,
  ModelChoice,
  Progress,
  RunContext,
} from "@/providers/types";

export interface FormState extends PersistedForm {
  mode: Mode;
  initImage: InputImage | null;
  mask: InputImage | null;
  /** Images attached to the prompt, sent to the model as references. */
  references: InputImage[];
}

/** The most reference images any backend takes. */
export const MAX_REFERENCES = 16;

export interface Job {
  status: "running" | "error";
  startedAt: number;
  progress?: Progress;
  error?: string;
  controller?: AbortController;
}

export interface CreditState {
  /** null: this connection is not set up to report credit. */
  info?: CreditInfo | null;
  error?: string;
  loading?: boolean;
  updatedAt?: number;
}

/** Credit is re-read at most this often unless forced. */
const CREDIT_TTL_MS = 60_000;

/**
 * What a caller decides for one generation. Everything else (model, steps,
 * sampler, provider options, workflow) comes from the active connection's form.
 */
export interface GenerationRequest {
  mode: Mode;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  count: number;
  /** Null picks a random seed. */
  seed: number | null;
  strength: number;
  initImage: InputImage | null;
  mask: InputImage | null;
  references?: InputImage[];
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

export interface ChatModelsState {
  models?: ChatModel[];
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
  references: [],
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
  credits: Record<string, CreditState>;
  /** Bumped whenever the gallery contents change. */
  galleryVersion: number;
  notice: string | null;
  /** Chat model for the prompt helper and the pixel assistant; null picks the first one available. */
  assistant: AssistantChoice | null;
  chatModels: Record<string, ChatModelsState>;

  init(): Promise<void>;
  setAssistant(choice: AssistantChoice): void;
  loadChatModels(connectionId: string): Promise<void>;
  setForm(patch: Partial<FormState>): void;
  selectConnection(id: string): void;
  saveConnection(connection: Connection, secrets: Record<string, string | null>): Promise<void>;
  removeConnection(id: string): Promise<void>;
  loadChoices(connectionId: string): Promise<void>;
  loadCredit(connectionId: string, options?: { force?: boolean }): Promise<void>;
  importWorkflow(file: File): Promise<SavedWorkflow | null>;
  saveWorkflow(workflow: SavedWorkflow): Promise<void>;
  deleteWorkflow(id: string): Promise<void>;
  selectWorkflow(id: string | null): void;
  /** Runs one generation on the active connection and saves the result to the gallery. */
  runGeneration(
    request: GenerationRequest,
    ctx: RunContext,
  ): Promise<{ record: GenerationRecord; images: GeneratedImage[] }>;
  generate(): Promise<void>;
  cancel(): void;
  dismissJob(): void;
  select(generation: GenerationRecord, imageIndex?: number): void;
  reuseSettings(generation: GenerationRecord): void;
  loadAsInput(image: ImageRecord): Promise<void>;
  setInputFromFile(file: File, target: "initImage" | "mask"): Promise<void>;
  /** Attaches image files to the prompt as references; other files are skipped with a notice. */
  addReferences(files: File[]): Promise<void>;
  loadAsReference(image: ImageRecord): Promise<void>;
  removeReference(index: number): void;
  toggleFavorite(image: ImageRecord): Promise<void>;
  removeImage(image: ImageRecord): Promise<void>;
  removeGeneration(generation: GenerationRecord): Promise<void>;
  notify(message: string | null): void;
}

type Selectable = Pick<AppState, "connections" | "activeConnectionId" | "workflows" | "form">;

/** The image backend in use. Chat-only connections (Claude) are never active. */
export const activeConnection = (s: Pick<AppState, "connections" | "activeConnectionId">): ImageConnection | null => {
  const connection = s.connections.find((c) => c.id === s.activeConnectionId);
  return connection && isImageConnection(connection) ? connection : null;
};

export interface Assistant {
  connection: Connection;
  chat: ChatService;
  model: string;
}

/** The saved assistant choice, or else the first connection that has chat models. */
export function assistantFor(s: Pick<AppState, "connections" | "assistant">): Assistant | null {
  const candidates = s.connections.filter((c) => chatService(c));
  const chosen = candidates.find((c) => c.id === s.assistant?.connectionId) ?? candidates[0];
  if (!chosen) return null;
  const chat = chatService(chosen)!;
  const model = (chosen.id === s.assistant?.connectionId && s.assistant.model.trim()) || chat.defaultModel;
  return { connection: chosen, chat, model };
}

export function useAssistant(): Assistant | null {
  const connections = useApp((s) => s.connections);
  const assistant = useApp((s) => s.assistant);
  return useMemo(() => assistantFor({ connections, assistant }), [connections, assistant]);
}

/** The imported workflow selected for the active connection, if any. */
export const activeWorkflow = (s: Selectable) => {
  const connection = activeConnection(s);
  if (!connection || !provider(connection.kind).supportsWorkflows) return null;
  const id = s.form.options.workflow;
  return id ? (s.workflows.find((w) => w.id === id) ?? null) : null;
};

export function capabilitiesFor(connection: ImageConnection | null, workflow: SavedWorkflow | null): Capabilities | null {
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
  connection: ImageConnection | null,
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
    const { form, forms, activeConnectionId, connections } = get();
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
    // A connection being removed is still active until the next one is picked;
    // writing its entry here would bring back the form state just deleted.
    if (activeConnectionId && connections.some((c) => c.id === activeConnectionId)) {
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
  const loadWorkflowChoices = async (connection: ImageConnection, workflow: SavedWorkflow) => {
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
    credits: {},
    galleryVersion: 0,
    notice: null,
    assistant: null,
    chatModels: {},

    async init() {
      if (get().ready) return;
      const settings = await loadSettings();
      const backends = settings.connections.filter(isImageConnection);
      const active = backends.find((c) => c.id === settings.activeConnectionId) ?? backends[0] ?? null;
      const base: FormState = { ...BASE_FORM, ...settings.forms[GLOBAL_KEY] };
      const recent = await listGenerations({ limit: 40 }).catch(() => []);
      set({
        ready: true,
        connections: settings.connections,
        activeConnectionId: active?.id ?? null,
        forms: settings.forms,
        form: formFor(active, settings.forms, base),
        workflows: settings.workflows,
        assistant: settings.assistant,
        recent,
        selection: recent[0] ? { generationId: recent[0].id, imageIndex: 0 } : null,
      });
      if (active) {
        void get().loadChoices(active.id);
        void get().loadCredit(active.id);
      }
    },

    setAssistant(choice) {
      set({ assistant: choice });
      void saveSetting("assistant", choice);
    },

    async loadChatModels(connectionId) {
      const connection = get().connections.find((c) => c.id === connectionId);
      const chat = connection && chatService(connection);
      const current = get().chatModels[connectionId];
      if (!connection || !chat || current?.loading || current?.models) return;
      const update = (patch: ChatModelsState) =>
        set((s) => ({ chatModels: { ...s.chatModels, [connectionId]: { ...s.chatModels[connectionId], ...patch } } }));
      update({ loading: true, error: undefined });
      try {
        const models = await chat.listModels(await resolveConfig(connection), AbortSignal.timeout(20_000));
        update({ models, loading: false });
      } catch (err) {
        update({ loading: false, error: errorMessage(err) });
      }
    },

    setForm(patch) {
      set((s) => ({ form: { ...s.form, ...patch } }));
      persistForm();
    },

    selectConnection(id) {
      const connection = get().connections.find((c) => c.id === id) ?? null;
      if (!connection || !isImageConnection(connection)) return;
      const forms = flushForm();
      set({ activeConnectionId: id, form: formFor(connection, forms, get().form) });
      void saveSetting("activeConnectionId", id);
      if (!get().choices[id]?.models) void get().loadChoices(id);
      void get().loadCredit(id);
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
      set({
        connections,
        choices: { ...get().choices, [connection.id]: {} },
        credits: { ...get().credits, [connection.id]: {} },
        chatModels: { ...get().chatModels, [connection.id]: {} },
      });
      await saveSetting("connections", connections);
      void get().loadCredit(connection.id, { force: true });
      if (!isImageConnection(connection)) return;
      if (!activeConnection(get())) get().selectConnection(connection.id);
      else if (get().activeConnectionId === connection.id) void get().loadChoices(connection.id);
    },

    async removeConnection(id) {
      const connection = get().connections.find((c) => c.id === id);
      if (!connection) return;
      await deleteConnectionSecrets(connection).catch(() => {});
      const connections = get().connections.filter((c) => c.id !== id);
      const forms = { ...get().forms };
      delete forms[id];
      const credits = { ...get().credits };
      delete credits[id];
      set({ connections, forms, credits });
      await saveSetting("connections", connections);
      await saveSetting("forms", forms);
      if (get().assistant?.connectionId === id) {
        set({ assistant: null });
        await saveSetting("assistant", null);
      }
      if (get().activeConnectionId === id) {
        const next = connections.find(isImageConnection);
        if (next) get().selectConnection(next.id);
        else {
          set({ activeConnectionId: null });
          await saveSetting("activeConnectionId", null);
        }
      }
    },

    async loadChoices(connectionId) {
      const connection = get().connections.find((c) => c.id === connectionId);
      if (!connection || !isImageConnection(connection)) return;
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

    async loadCredit(connectionId, { force = false } = {}) {
      const connection = get().connections.find((c) => c.id === connectionId);
      const def = connection && service(connection.kind);
      if (!connection || !def?.getCredit) return;
      const current = get().credits[connectionId];
      if (current?.loading) return;
      if (!force && current?.updatedAt && Date.now() - current.updatedAt < CREDIT_TTL_MS) return;
      const update = (patch: CreditState) =>
        set((s) => ({ credits: { ...s.credits, [connectionId]: { ...s.credits[connectionId], ...patch } } }));
      update({ loading: true });
      try {
        const info = await def.getCredit(await resolveConfig(connection), AbortSignal.timeout(20_000));
        update({ info, error: undefined, loading: false, updatedAt: Date.now() });
      } catch (err) {
        const timedOut = err instanceof DOMException && err.name === "TimeoutError";
        update({ error: timedOut ? "No answer within 20 seconds." : errorMessage(err), loading: false, updatedAt: Date.now() });
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

    async runGeneration(request, ctx) {
      const state = get();
      const connection = activeConnection(state);
      if (!connection) throw new Error("Add a connection first.");
      const def = provider(connection.kind);
      const workflow = activeWorkflow(state);
      const caps = def.capabilities(connection.config, workflow);
      const { form } = state;
      const startedAt = Date.now();

      const params: GenerateParams = {
        mode: request.mode,
        prompt: request.prompt.trim(),
        negativePrompt: caps.negativePrompt ? request.negativePrompt.trim() : "",
        model: caps.model ? form.model.trim() : "",
        width: roundTo(request.width, caps.sizeStep),
        height: roundTo(request.height, caps.sizeStep),
        count: Math.min(Math.max(1, request.count), caps.maxCount),
        seed: caps.seed && request.seed !== null ? request.seed : randomSeed(),
        steps: form.steps,
        cfg: form.cfg,
        sampler: form.sampler,
        scheduler: form.scheduler,
        strength: request.strength,
        initImage: request.mode === "img2img" ? request.initImage : null,
        mask: request.mode === "img2img" && caps.mask ? request.mask : null,
        references: request.references ?? [],
        options: form.options,
        workflow,
      };
      if (params.references.length > caps.references) {
        throw new Error(
          caps.references
            ? `${def.label} takes at most ${caps.references} reference images. Remove some.`
            : `${def.label} cannot use reference images. Remove them, or switch to OpenAI, OpenRouter, fal.ai or Replicate.`,
        );
      }

      const config = await resolveConfig(connection);
      const missing = def.fields.filter((f) => f.required && !config[f.key]?.trim());
      if (missing.length) {
        throw new Error(
          `${connection.name} needs ${missing.map((f) => midSentence(f.label)).join(" and ")}. Add it in Connections.`,
        );
      }
      const result = await def.generate(params, config, ctx);
      if (ctx.signal.aborted) throw new DOMException("canceled", "AbortError");

      const record = await saveGeneration(
        {
          id: crypto.randomUUID(),
          createdAt: startedAt,
          provider: connection.kind,
          connectionName: connection.name,
          model: result.model || params.model || (workflow ? workflow.name : def.defaultModel(config)) || null,
          mode: params.mode,
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
            info: {
              ...result.info,
              ...(workflow ? { workflow: workflow.name } : {}),
              ...(params.references.length ? { references: params.references.length } : {}),
            },
          },
          durationMs: Date.now() - startedAt,
        },
        result.images,
      );
      set((s) => ({ recent: [record, ...s.recent], galleryVersion: s.galleryVersion + 1 }));
      // Providers book the charge shortly after the job finishes.
      setTimeout(() => void get().loadCredit(connection.id, { force: true }), 2500);
      return { record, images: result.images };
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

      const controller = new AbortController();
      const startedAt = Date.now();
      set({
        job: { status: "running", startedAt, controller, progress: { stage: "queued", message: "Starting" } },
      });

      try {
        const { record } = await get().runGeneration(
          {
            mode,
            prompt: form.prompt,
            negativePrompt: form.negativePrompt,
            width: form.width,
            height: form.height,
            count: form.count,
            seed: form.seed,
            strength: form.strength,
            initImage: form.initImage,
            mask: form.mask,
            references: form.references,
          },
          {
            signal: controller.signal,
            onProgress: (progress) =>
              set((s) => (s.job?.controller === controller ? { job: { ...s.job, progress } } : {})),
          },
        );
        set({ job: null, selection: { generationId: record.id, imageIndex: 0 } });
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

    async addReferences(files) {
      const added: InputImage[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mime = sniffImageMime(bytes, file.type);
        const size = mime.startsWith("image/") ? await imageDimensions(bytes, mime) : null;
        if (size) added.push({ bytes, mime, name: file.name || "Pasted image", ...size });
        else skipped.push(file.name || "a pasted file");
      }
      const current = get().form.references;
      const room = MAX_REFERENCES - current.length;
      if (added.length) get().setForm({ references: [...current, ...added.slice(0, Math.max(0, room))] });
      if (added.length > room) set({ notice: `Up to ${MAX_REFERENCES} reference images; the rest were left out.` });
      else if (skipped.length) set({ notice: `${skipped.join(", ")} ${skipped.length === 1 ? "is not an image" : "are not images"} this app can read.` });
    },

    async loadAsReference(image) {
      const current = get().form.references;
      if (current.length >= MAX_REFERENCES) throw new Error(`Up to ${MAX_REFERENCES} reference images.`);
      const bytes = await readImageBytes(image.id);
      const reference: InputImage = { bytes, mime: image.mime, name: image.fileName, width: image.width ?? 1024, height: image.height ?? 1024 };
      get().setForm({ references: [...current, reference] });
    },

    removeReference(index) {
      get().setForm({ references: get().form.references.filter((_, i) => i !== index) });
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
