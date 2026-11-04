// The Rust commands behind the Training area. Files, credentials and the
// SSH connection stay on the Rust side; these calls name a project, a photo
// or a run and get records back.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Connection, ConnectionConfig } from "@/providers/types";

import type { RunRecord } from "./jobs";
import type { TrainingConfig } from "./trainers";

export interface Project {
  id: string;
  name: string;
  objective: string;
  triggerToken: string;
  trainer: string;
  family: string;
  baseModel: string;
  config: TrainingConfig;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  project: Project;
  itemCount: number;
  includedCount: number;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Category = "" | "face" | "upper-body" | "full-body";

export interface DatasetItem {
  id: string;
  projectId: string;
  fileName: string;
  originalName: string;
  sha256: string;
  width: number | null;
  height: number | null;
  orientation: number;
  hasLocation: boolean;
  decodeError: string | null;
  caption: string;
  captionSource: "" | "manual" | "assistant";
  captionSuggestion: string | null;
  included: boolean;
  category: Category;
  crop: Crop | null;
  addedAt: number;
  path: string;
  thumbPath: string | null;
}

export interface ItemPatch {
  caption?: string;
  captionSource?: "" | "manual" | "assistant";
  captionSuggestion?: string | null;
  included?: boolean;
  category?: Category;
  crop?: Crop | null;
}

export interface ImportReport {
  added: number;
  duplicates: [string, string][];
  unsupported: string[];
  unreadable: string[];
  withLocation: number;
}

export interface Artifact {
  id: string;
  projectId: string;
  runId: string;
  step: number;
  family: string;
  baseModel: string;
  trainer: string;
  triggerToken: string;
  datasetHash: string;
  fileName: string;
  size: number;
  sha256: string;
  manifest: Record<string, unknown>;
  installs: { hostId: string; hostLabel: string; dir: string; fileName: string; at: number }[];
  createdAt: number;
}

/** A training host as the Rust side needs it. Secrets are read there, from the keychain. */
export interface HostSpec {
  connectionId: string;
  label: string;
  host: string;
  port: number;
  user: string;
  workspace: string;
  python: string;
  loraDir?: string | null;
  privateKey?: string;
  passphrase?: string;
}

export const DEFAULT_WORKSPACE = "/workspace/imagegen-train";

export function hostSpec(connection: Pick<Connection, "id" | "name">, config: ConnectionConfig, withSecrets = false): HostSpec {
  return {
    connectionId: connection.id,
    label: connection.name,
    host: (config.host ?? "").trim(),
    port: Number(config.port) || 22,
    user: (config.user ?? "root").trim() || "root",
    workspace: (config.workspace ?? "").trim() || DEFAULT_WORKSPACE,
    python: (config.python ?? "").trim() || "python3",
    loraDir: config.loraDir?.trim() || null,
    ...(withSecrets ? { privateKey: config.privateKey, passphrase: config.passphrase } : {}),
  };
}

export const imagePath = (path: string) => convertFileSrc(path);

export const listProjects = () => invoke<ProjectSummary[]>("training_projects");

export const createProject = (input: Omit<Project, "id" | "trainer" | "createdAt" | "updatedAt">) =>
  invoke<Project>("training_project_create", { input });

export const updateProject = (id: string, input: Omit<Project, "id" | "trainer" | "createdAt" | "updatedAt">) =>
  invoke<Project>("training_project_update", { id, input });

export const deleteProject = (id: string) => invoke<void>("training_project_delete", { id });

export const listItems = (projectId: string) => invoke<DatasetItem[]>("training_items", { projectId });

export const importWithDialog = (projectId: string, folder: boolean) =>
  invoke<ImportReport | null>("training_import_dialog", { projectId, folder });

export const importBytes = (projectId: string, name: string, bytes: Uint8Array) =>
  invoke<ImportReport>("training_import_bytes", bytes, {
    headers: { "x-project-id": projectId, "x-file-name": encodeURIComponent(name) },
  });

export const patchItem = (id: string, patch: ItemPatch) => invoke<DatasetItem>("training_item_patch", { id, patch });

export const deleteItem = (id: string) => invoke<void>("training_item_delete", { id });

/** A reduced copy without metadata, for a captioning service. */
export async function captionImage(id: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("training_caption_image", { id }));
}

export const testHost = (spec: HostSpec) => invoke<{ runnerVersion: number; trainer: string; diffusers: string }>("training_host_test", { spec });

export const trustHost = (spec: HostSpec, fingerprint: string) => invoke<void>("training_host_trust", { spec, fingerprint });

export interface Preflight {
  runnerVersion: number;
  python: string;
  workspace: string;
  error?: string;
  gpus: { index: number; name: string; memoryTotalMiB: number; memoryUsedMiB: number; driver: string }[];
  processes: { pid: number; name: string; memoryMiB: number }[];
  disk: { freeBytes: number; totalBytes: number };
  environment: {
    venv: boolean;
    trainerScript: boolean;
    trainerScriptVerified?: boolean;
    packages?: Record<string, string | null>;
    cuda?: boolean;
    torchCuda?: string | null;
    pipeline?: boolean;
    pipelineError?: string;
    torchError?: string;
    probeError?: string;
  };
  setup: SetupStatus | null;
  model?: { repo: string; downloaded: boolean; missing?: string[]; revision?: string; path?: string };
  loraDir?: { path: string; exists: boolean; writable: boolean };
  jobs: { jobId: string; state: string; running: boolean }[];
}

export interface SetupStatus {
  state: "running" | "completed" | "failed";
  step?: string | null;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export const preflight = (spec: HostSpec, baseModel: string) => invoke<Preflight>("training_host_preflight", { spec, baseModel });

export const startSetup = (spec: HostSpec, baseModel: string | null) =>
  invoke<{ setup: SetupStatus }>("training_host_setup", { spec, baseModel });

export const setupStatus = (spec: HostSpec) => invoke<{ setup: SetupStatus | null; logTail: string }>("training_host_setup_status", { spec });

export const listRuns = (projectId: string) => invoke<RunRecord[]>("training_runs", { projectId });

export const createRun = (projectId: string, spec: HostSpec, baseRevision: string | null) =>
  invoke<RunRecord>("training_run_create", { projectId, spec, baseRevision });

export const uploadRun = (runId: string, spec: HostSpec) => invoke<RunRecord>("training_run_upload", { runId, spec });
export const startRun = (runId: string, spec: HostSpec) => invoke<RunRecord>("training_run_start", { runId, spec });
export const resumeRun = (runId: string, spec: HostSpec) => invoke<RunRecord>("training_run_resume", { runId, spec });
export const runStatus = (runId: string, spec: HostSpec) => invoke<RunRecord>("training_run_status", { runId, spec });
export const cancelRun = (runId: string, spec: HostSpec) => invoke<RunRecord>("training_run_cancel", { runId, spec });
export const cleanupRemote = (runId: string, spec: HostSpec) => invoke<RunRecord>("training_run_cleanup_remote", { runId, spec });
export const deleteRun = (runId: string) => invoke<void>("training_run_delete", { runId });

export const registerArtifact = (runId: string, step: number, spec: HostSpec) =>
  invoke<Artifact>("training_artifact_register", { runId, step, spec });

export const listArtifacts = (projectId: string | null = null) => invoke<Artifact[]>("training_artifacts", { projectId });

export const exportArtifact = (id: string, manifestOnly: boolean) =>
  invoke<string | null>("training_artifact_export", { id, manifestOnly });

export const installArtifact = (id: string, spec: HostSpec) => invoke<Artifact>("training_artifact_install", { id, spec });

export const deleteArtifact = (id: string) => invoke<void>("training_artifact_delete", { id });

export interface TransferProgress {
  runId: string;
  phase: "upload" | "download" | "install";
  done: number;
  total: number;
}

export const onTransferProgress = (handler: (progress: TransferProgress) => void) =>
  listen<TransferProgress>("training-progress", (event) => handler(event.payload));

/** A host key the user has to approve, carried in a connection error. */
export interface HostKeyProblem {
  kind: "unknown" | "changed";
  fingerprint: string;
  algorithm: string;
}

export function hostKeyProblem(err: unknown): HostKeyProblem | null {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  const at = text.indexOf("HOST_KEY:");
  if (at < 0) return null;
  try {
    return JSON.parse(text.slice(at + "HOST_KEY:".length)) as HostKeyProblem;
  } catch {
    return null;
  }
}

/** Words for an error from these commands, with host-key problems spelled out. */
export function describeTrainingError(err: unknown): string {
  const problem = hostKeyProblem(err);
  if (problem?.kind === "unknown") {
    return `This host's key is not known yet (${problem.algorithm} ${problem.fingerprint}). Compare it with the host's own key, then trust it in Connections.`;
  }
  if (problem?.kind === "changed") {
    return `This host's key has changed (now ${problem.algorithm} ${problem.fingerprint}). That happens when a Pod is recreated, and also in an attack. If the host was rebuilt, remove its old entry from known_hosts, then trust the new key in Connections.`;
  }
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}
