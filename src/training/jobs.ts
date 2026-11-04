// What a training run's state means for the user, from the app's last check
// of its host. A check that could not reach the host says nothing about the
// training: the run keeps its last known state, marked as unconfirmed.

export type RunState =
  | "draft"
  | "uploading"
  | "uploaded"
  | "queued"
  | "preparing"
  | "training"
  | "saving"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled"
  | "missing"
  | "removed"
  | "unknown";

export interface Checkpoint {
  step: number;
  kind: "checkpoint" | "final";
  size: number;
  /** Holds optimizer state, so training can continue from it. */
  resumable: boolean;
}

export interface ValidationImage {
  step: number | null;
  label: string;
  prompt: number;
  seed: number;
  file: string;
}

export interface HostReport {
  state: string;
  step?: number | null;
  maxSteps?: number | null;
  loss?: number | null;
  lr?: number | null;
  secondsPerStep?: number | null;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  now?: number;
  error?: { kind: string; message: string } | null;
  validationError?: string;
  checkpoints?: Checkpoint[];
  resumeStep?: number | null;
  resumedFrom?: number | null;
  lossHistory?: [number, number][];
  validation?: { prompts?: string[]; seeds?: number[]; images: ValidationImage[]; progress?: { done: number; total: number } };
  logTail?: string;
  modelRevision?: string;
  trainerVersion?: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  createdAt: number;
  hostId: string;
  hostLabel: string;
  snapshot: RunSnapshot;
  datasetHash: string;
  remoteDir: string;
  state: RunState;
  remote: HostReport | null;
  connection: "unchecked" | "ok" | "lost";
  connectionError: string | null;
  checkedAt: number | null;
  updatedAt: number;
  /** Local copies of validation images, by their file on the host. */
  validationFiles: Record<string, string>;
}

export interface RunSnapshot {
  trainer: string;
  trainerVersion: string;
  family: string;
  baseModel: string;
  baseRevision: string;
  triggerToken: string;
  instancePrompt: string;
  conversion: string;
  config: import("./trainers").TrainingConfig;
  items: { itemId: string; name: string; sha256: string; caption: string; category: string; width: number; height: number }[];
  datasetHash: string;
}

const ACTIVE: RunState[] = ["queued", "preparing", "training", "saving", "validating"];
const TERMINAL: RunState[] = ["completed", "failed", "cancelled"];

/** Running on the host, as far as the app last knew. */
export const isActive = (state: RunState) => ACTIVE.includes(state);

export const isTerminal = (state: RunState) => TERMINAL.includes(state);

/** Worth checking again on a timer. */
export const needsPolling = (run: RunRecord) => isActive(run.state) || (run.state === "uploaded" && run.connection === "lost");

const LABELS: Record<RunState, string> = {
  draft: "Not uploaded",
  uploading: "Uploading",
  uploaded: "Uploaded, not started",
  queued: "Queued behind another run",
  preparing: "Preparing (loading models, caching latents)",
  training: "Training",
  saving: "Saving a checkpoint",
  validating: "Generating validation images",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  missing: "No longer on the host",
  removed: "Removed from the host",
  unknown: "Status unknown",
};

export interface RunDisplay {
  label: string;
  tone: "running" | "ok" | "error" | "idle" | "unknown";
  /** Why the state is uncertain, or what went wrong. */
  detail?: string;
}

export function runDisplay(run: RunRecord): RunDisplay {
  const label = LABELS[run.state] ?? run.state;
  if (run.connection === "lost" && !isTerminal(run.state) && run.state !== "draft") {
    return {
      label: `${label}, as last seen`,
      tone: "unknown",
      detail: `Could not reach ${run.hostLabel}${run.connectionError ? `: ${run.connectionError}` : ""}. The run keeps going on the host; this is its state at the last successful check.`,
    };
  }
  if (run.state === "failed") return { label, tone: "error", detail: run.remote?.error?.message };
  if (run.state === "completed") {
    return { label, tone: "ok", detail: run.remote?.validationError ? `Validation images failed: ${run.remote.validationError}` : undefined };
  }
  if (run.state === "missing") return { label, tone: "error", detail: "Its job folder is gone from the host, so its checkpoints are too." };
  if (run.state === "uploading") {
    return { label: "Upload interrupted", tone: "idle", detail: "Upload again to continue where it stopped." };
  }
  return { label, tone: isActive(run.state) ? "running" : "idle" };
}

export const canCancel = (run: RunRecord) => isActive(run.state);

/** Only from a checkpoint with training state; a LoRA file alone cannot continue a run. */
export const canResume = (run: RunRecord) =>
  (run.state === "failed" || run.state === "cancelled") && run.connection !== "lost" && typeof run.remote?.resumeStep === "number";

export interface Progress {
  step: number | null;
  maxSteps: number;
  loss: number | null;
  /** Seconds since training started, on the host's clock. */
  elapsed: number | null;
  /** Measured from this run's own steps; null until there are some. */
  secondsPerStep: number | null;
  /** Remaining training time at the measured pace; validation not included. */
  remaining: number | null;
}

export function runProgress(run: RunRecord): Progress {
  const r = run.remote;
  const maxSteps = r?.maxSteps ?? run.snapshot.config.maxSteps;
  const step = typeof r?.step === "number" ? r.step : null;
  const end = r?.finishedAt ?? r?.now;
  const elapsed = r?.startedAt && end ? Math.max(0, end - r.startedAt) : null;
  const pace = r?.secondsPerStep && r.secondsPerStep > 0 ? r.secondsPerStep : null;
  return {
    step,
    maxSteps,
    loss: typeof r?.loss === "number" ? r.loss : null,
    elapsed,
    secondsPerStep: pace,
    remaining: pace && step !== null && isActive(run.state) ? Math.max(0, maxSteps - step) * pace : null,
  };
}

/** A cost at the measured pace, only when the host's hourly price is known. */
export function costEstimate(seconds: number | null, hourlyPrice: number | null): number | null {
  if (seconds === null || hourlyPrice === null || !(hourlyPrice > 0)) return null;
  return (seconds / 3600) * hourlyPrice;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s % 60} s`;
  return `${s} s`;
}

/** Validation images by step label, then prompt and seed, for side-by-side comparison. */
export function validationGrid(run: RunRecord) {
  const images = run.remote?.validation?.images ?? [];
  const labels = [...new Set(images.map((i) => i.label))].sort((a, b) =>
    a === "base" ? -1 : b === "base" ? 1 : Number(a) - Number(b),
  );
  const cell = (label: string, prompt: number, seed: number) => {
    const image = images.find((i) => i.label === label && i.prompt === prompt && i.seed === seed);
    return image ? (run.validationFiles[image.file] ?? null) : null;
  };
  return { labels, prompts: run.remote?.validation?.prompts ?? run.snapshot.config.validationPrompts, seeds: run.remote?.validation?.seeds ?? run.snapshot.config.validationSeeds, cell };
}
