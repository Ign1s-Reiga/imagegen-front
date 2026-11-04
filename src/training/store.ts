// State for the Training area: the projects list, the open project's photos,
// runs and LoRAs. Photographs and model files stay on disk; this holds only
// their records and paths.

import { create } from "zustand";

import type { Connection } from "@/providers/types";

import * as api from "./api";
import { acceptSuggestion, suggestCaptions, type CaptionProgress } from "./captions";
import { needsPolling, type RunRecord } from "./jobs";
import type { TrainingConfig } from "./trainers";

export const isHost = (c: Connection) => c.kind === "gpuhost";

export const specFor = (host: Connection) => api.hostSpec(host, host.config);

interface HostState {
  preflight?: api.Preflight;
  checking?: boolean;
  error?: string;
  setup?: api.SetupStatus | null;
  setupLog?: string;
}

interface TrainingState {
  projects: api.ProjectSummary[];
  loaded: boolean;
  projectId: string | null;
  items: api.DatasetItem[];
  runs: RunRecord[];
  artifacts: api.Artifact[];
  hostId: string | null;
  hosts: Record<string, HostState>;
  /** Per run: an action in flight ("upload", "start", "status", ...). */
  busy: Record<string, string>;
  transfer: api.TransferProgress | null;
  captioning: (CaptionProgress & { controller: AbortController }) | null;

  loadProjects(): Promise<void>;
  open(projectId: string | null): Promise<void>;
  createProject(input: Omit<api.Project, "id" | "trainer" | "createdAt" | "updatedAt">): Promise<api.Project>;
  saveProject(project: api.Project, patch: Partial<Pick<api.Project, "name" | "objective" | "triggerToken">> & { config?: TrainingConfig }): Promise<void>;
  deleteProject(id: string): Promise<void>;
  refreshItems(): Promise<void>;
  importDialog(folder: boolean): Promise<api.ImportReport | null>;
  importFiles(files: File[]): Promise<api.ImportReport>;
  patchItem(id: string, patch: api.ItemPatch): Promise<void>;
  deleteItem(id: string): Promise<void>;
  captionSuggestions(items: api.DatasetItem[], ask: (item: api.DatasetItem, signal: AbortSignal) => Promise<string>): Promise<CaptionProgress>;
  stopCaptioning(): void;
  acceptSuggestions(replaceManual: boolean): Promise<number>;
  setHost(id: string | null): void;
  checkHost(host: Connection): Promise<void>;
  startSetup(host: Connection, downloadModel: string | null): Promise<void>;
  checkSetup(host: Connection): Promise<void>;
  refreshRuns(): Promise<void>;
  refreshArtifacts(): Promise<void>;
  launch(host: Connection, baseRevision: string | null): Promise<RunRecord>;
  runAction(run: RunRecord, host: Connection, action: "upload" | "start" | "status" | "cancel" | "resume" | "cleanup"): Promise<RunRecord>;
  deleteRun(run: RunRecord): Promise<void>;
  pollRuns(hosts: Connection[]): Promise<void>;
  register(run: RunRecord, step: number, host: Connection): Promise<api.Artifact>;
  install(artifact: api.Artifact, host: Connection): Promise<api.Artifact>;
  deleteArtifact(id: string): Promise<void>;
}

const replaceRun = (runs: RunRecord[], run: RunRecord) =>
  runs.some((r) => r.id === run.id) ? runs.map((r) => (r.id === run.id ? run : r)) : [run, ...runs];

export const useTraining = create<TrainingState>()((set, get) => {
  const setBusy = (runId: string, action: string | null) =>
    set((s) => {
      const busy = { ...s.busy };
      if (action) busy[runId] = action;
      else delete busy[runId];
      return { busy };
    });
  const setHostState = (id: string, patch: HostState) =>
    set((s) => ({ hosts: { ...s.hosts, [id]: { ...s.hosts[id], ...patch } } }));

  // Only in the app's window: the page is also rendered at build time.
  if (typeof window !== "undefined") {
    api.onTransferProgress((progress) => set({ transfer: progress })).catch(() => {});
  }

  return {
    projects: [],
    loaded: false,
    projectId: null,
    items: [],
    runs: [],
    artifacts: [],
    hostId: null,
    hosts: {},
    busy: {},
    transfer: null,
    captioning: null,

    async loadProjects() {
      const projects = await api.listProjects();
      set({ projects, loaded: true });
    },

    async open(projectId) {
      get().captioning?.controller.abort();
      set({ projectId, items: [], runs: [], captioning: null });
      if (!projectId) return;
      const [items, runs, artifacts] = await Promise.all([api.listItems(projectId), api.listRuns(projectId), api.listArtifacts(projectId)]);
      if (get().projectId === projectId) set({ items, runs, artifacts });
    },

    async createProject(input) {
      const project = await api.createProject(input);
      await get().loadProjects();
      await get().open(project.id);
      return project;
    },

    async saveProject(project, patch) {
      const next = { ...project, ...patch };
      await api.updateProject(project.id, {
        name: next.name,
        objective: next.objective,
        triggerToken: next.triggerToken,
        family: next.family,
        baseModel: next.baseModel,
        config: next.config,
      });
      await get().loadProjects();
    },

    async deleteProject(id) {
      await api.deleteProject(id);
      if (get().projectId === id) await get().open(null);
      await get().loadProjects();
    },

    async refreshItems() {
      const id = get().projectId;
      if (!id) return;
      const items = await api.listItems(id);
      if (get().projectId === id) set({ items });
    },

    async importDialog(folder) {
      const id = get().projectId;
      if (!id) return null;
      const report = await api.importWithDialog(id, folder);
      if (report) {
        await get().refreshItems();
        void get().loadProjects();
      }
      return report;
    },

    async importFiles(files) {
      const id = get().projectId;
      const total: api.ImportReport = { added: 0, duplicates: [], unsupported: [], unreadable: [], withLocation: 0 };
      if (!id) return total;
      for (const file of files) {
        const report = await api.importBytes(id, file.name, new Uint8Array(await file.arrayBuffer()));
        total.added += report.added;
        total.duplicates.push(...report.duplicates);
        total.unsupported.push(...report.unsupported);
        total.unreadable.push(...report.unreadable);
        total.withLocation += report.withLocation;
      }
      await get().refreshItems();
      void get().loadProjects();
      return total;
    },

    async patchItem(id, patch) {
      const item = await api.patchItem(id, patch);
      set((s) => ({ items: s.items.map((i) => (i.id === id ? item : i)) }));
      if (patch.included !== undefined) void get().loadProjects();
    },

    async deleteItem(id) {
      await api.deleteItem(id);
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
      void get().loadProjects();
    },

    async captionSuggestions(items, ask) {
      get().captioning?.controller.abort();
      const controller = new AbortController();
      set({ captioning: { done: 0, total: items.length, failed: 0, controller } });
      const result = await suggestCaptions(
        items,
        (item, signal) => ask(item as api.DatasetItem, signal),
        // Saved one by one, so stopping or a crash keeps what was done.
        (item, suggestion) => get().patchItem(item.id, { captionSuggestion: suggestion }),
        controller.signal,
        (progress) => {
          if (get().captioning?.controller === controller) set({ captioning: { ...progress, controller } });
        },
      );
      if (get().captioning?.controller === controller) set({ captioning: null });
      return result;
    },

    stopCaptioning() {
      get().captioning?.controller.abort();
      set({ captioning: null });
    },

    async acceptSuggestions(replaceManual) {
      let accepted = 0;
      for (const item of get().items) {
        const change = acceptSuggestion(item, replaceManual);
        if (!change) continue;
        await get().patchItem(item.id, change);
        accepted++;
      }
      return accepted;
    },

    setHost(id) {
      set({ hostId: id });
    },

    async checkHost(host) {
      const project = get().projects.find((p) => p.project.id === get().projectId)?.project;
      setHostState(host.id, { checking: true, error: undefined });
      try {
        const preflight = await api.preflight(specFor(host), project?.baseModel ?? "Qwen/Qwen-Image-2.1");
        setHostState(host.id, { preflight, checking: false, setup: preflight.setup });
      } catch (err) {
        setHostState(host.id, { checking: false, error: api.describeTrainingError(err) });
      }
    },

    async startSetup(host, downloadModel) {
      setHostState(host.id, { error: undefined });
      try {
        const result = await api.startSetup(specFor(host), downloadModel);
        setHostState(host.id, { setup: result.setup });
      } catch (err) {
        setHostState(host.id, { error: api.describeTrainingError(err) });
      }
    },

    async checkSetup(host) {
      try {
        const result = await api.setupStatus(specFor(host));
        setHostState(host.id, { setup: result.setup, setupLog: result.logTail });
        if (result.setup?.state !== "running") void get().checkHost(host);
      } catch (err) {
        setHostState(host.id, { error: api.describeTrainingError(err) });
      }
    },

    async refreshRuns() {
      const id = get().projectId;
      if (!id) return;
      const runs = await api.listRuns(id);
      if (get().projectId === id) set({ runs });
    },

    async refreshArtifacts() {
      const id = get().projectId;
      const artifacts = await api.listArtifacts(id);
      if (get().projectId === id) set({ artifacts });
    },

    async launch(host, baseRevision) {
      const projectId = get().projectId;
      if (!projectId) throw new Error("Open a project first.");
      const spec = specFor(host);
      // Recorded first, so the snapshot exists even if the upload is cut off.
      let run = await api.createRun(projectId, spec, baseRevision);
      set((s) => ({ runs: replaceRun(s.runs, run) }));
      run = await get().runAction(run, host, "upload");
      return get().runAction(run, host, "start");
    },

    async runAction(run, host, action) {
      const spec = specFor(host);
      setBusy(run.id, action);
      try {
        const call = {
          upload: api.uploadRun,
          start: api.startRun,
          status: api.runStatus,
          cancel: api.cancelRun,
          resume: api.resumeRun,
          cleanup: api.cleanupRemote,
        }[action];
        const updated = await call(run.id, spec);
        set((s) => ({ runs: replaceRun(s.runs, updated) }));
        return updated;
      } catch (err) {
        // The record (lost connection, upload left to continue) changed too.
        await get().refreshRuns();
        throw new Error(api.describeTrainingError(err), { cause: err });
      } finally {
        setBusy(run.id, null);
        if (get().transfer?.runId === run.id) set({ transfer: null });
      }
    },

    async deleteRun(run) {
      await api.deleteRun(run.id);
      set((s) => ({ runs: s.runs.filter((r) => r.id !== run.id) }));
    },

    async pollRuns(hosts) {
      for (const run of get().runs) {
        if (!needsPolling(run) || get().busy[run.id]) continue;
        const host = hosts.find((h) => h.id === run.hostId);
        if (!host) continue;
        await get().runAction(run, host, "status").catch(() => {
          // Recorded on the run as a lost connection; shown there.
        });
      }
    },

    async register(run, step, host) {
      setBusy(run.id, "register");
      try {
        const artifact = await api.registerArtifact(run.id, step, specFor(host));
        set((s) => ({ artifacts: [artifact, ...s.artifacts] }));
        return artifact;
      } catch (err) {
        throw new Error(api.describeTrainingError(err), { cause: err });
      } finally {
        setBusy(run.id, null);
      }
    },

    async install(artifact, host) {
      setBusy(artifact.runId, "install");
      try {
        const updated = await api.installArtifact(artifact.id, specFor(host));
        set((s) => ({ artifacts: s.artifacts.map((a) => (a.id === updated.id ? updated : a)) }));
        return updated;
      } catch (err) {
        throw new Error(api.describeTrainingError(err), { cause: err });
      } finally {
        setBusy(artifact.runId, null);
      }
    },

    async deleteArtifact(id) {
      await api.deleteArtifact(id);
      set((s) => ({ artifacts: s.artifacts.filter((a) => a.id !== id) }));
    },
  };
});
