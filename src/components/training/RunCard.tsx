"use client";

import { useState } from "react";

import type { Connection } from "@/providers/types";
import { useApp } from "@/store/app";
import { canCancel, canResume, costEstimate, formatDuration, isActive, runDisplay, runProgress, type RunRecord } from "@/training/jobs";
import { useTraining } from "@/training/store";

import { ErrorLogDialog } from "../ErrorLogDialog";
import { Button, cx } from "../ui";

const TONE = {
  running: "text-safelight",
  ok: "text-ok",
  error: "text-danger",
  idle: "text-fg-dim",
  unknown: "text-fg-dim",
};

/** The loss the trainer reported, step by step: a plain line, no smoothing. */
function LossChart({ history }: { history: [number, number][] }) {
  if (history.length < 2) return null;
  const steps = history.map(([s]) => s);
  const losses = history.map(([, l]) => l);
  const [x0, x1] = [Math.min(...steps), Math.max(...steps)];
  const [y0, y1] = [Math.min(...losses), Math.max(...losses)];
  const w = 320;
  const h = 64;
  const points = history
    .map(([s, l]) => `${((s - x0) / (x1 - x0 || 1)) * w},${h - ((l - y0) / (y1 - y0 || 1)) * h}`)
    .join(" ");
  return (
    <figure className="mt-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label="Training loss by step">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" className="text-fg-dim" />
      </svg>
      <figcaption className="flex justify-between text-[11.5px] text-fg-faint">
        <span>
          loss {y0.toFixed(3)} to {y1.toFixed(3)}
        </span>
        <span>
          steps {x0} to {x1}
        </span>
      </figcaption>
    </figure>
  );
}

export function RunCard({ run, hosts, onResults }: { run: RunRecord; hosts: Connection[]; onResults: () => void }) {
  const runAction = useTraining((s) => s.runAction);
  const deleteRun = useTraining((s) => s.deleteRun);
  const busy = useTraining((s) => s.busy[run.id]);
  const transfer = useTraining((s) => (s.transfer?.runId === run.id ? s.transfer : null));
  const notify = useApp((s) => s.notify);
  const [log, setLog] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "cleanup" | null>(null);
  const host = hosts.find((h) => h.id === run.hostId) ?? null;
  const display = runDisplay(run);
  const progress = runProgress(run);
  const hourly = host ? Number(host.config.hourlyPrice) || null : null;
  const remainingCost = costEstimate(progress.remaining, hourly);
  const r = run.remote;

  const act = (action: Parameters<typeof runAction>[2]) => {
    if (!host) return notify(`The host ${run.hostLabel} is no longer in Connections.`);
    setConfirm(null);
    runAction(run, host, action).catch((err: unknown) => notify(err instanceof Error ? err.message : String(err)));
  };

  return (
    <li className="rounded-[5px] border border-line bg-panel p-3.5">
      <div className="flex items-baseline gap-2">
        <span className={cx("font-medium", TONE[display.tone])}>{display.label}</span>
        <span className="ml-auto text-[12px] text-fg-faint">
          {new Date(run.createdAt).toLocaleString()} on {run.hostLabel}
        </span>
      </div>
      {display.detail && <p className={cx("mt-1 text-[13px] leading-snug", display.tone === "error" ? "text-danger" : "text-fg-dim")}>{display.detail}</p>}

      {transfer && (
        <p className="mt-1 text-[13px] text-fg-dim">
          {transfer.phase === "upload" ? "Uploading" : transfer.phase === "install" ? "Installing" : "Downloading"}{" "}
          {(transfer.done / 2 ** 20).toFixed(1)} of {(transfer.total / 2 ** 20).toFixed(1)} MB
        </p>
      )}

      <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-[13px]">
        <div>
          <dt className="text-fg-faint">Step</dt>
          <dd className="tabular-nums">{progress.step === null ? "Not reported yet" : `${progress.step} of ${progress.maxSteps}`}</dd>
        </div>
        <div>
          <dt className="text-fg-faint">Loss</dt>
          <dd className="tabular-nums">{progress.loss === null ? "Not reported yet" : progress.loss.toFixed(4)}</dd>
        </div>
        <div>
          <dt className="text-fg-faint">Elapsed</dt>
          <dd className="tabular-nums">{progress.elapsed === null ? "Not started" : formatDuration(progress.elapsed)}</dd>
        </div>
        {progress.secondsPerStep !== null && (
          <div className="col-span-3 text-fg-dim">
            Measured {progress.secondsPerStep.toFixed(1)} s per step
            {progress.remaining !== null && `, about ${formatDuration(progress.remaining)} of training left at that pace`}
            {remainingCost !== null && ` (about $${remainingCost.toFixed(2)} at ${host?.config.hourlyPrice}/h)`}. Validation
            images come after that.
          </div>
        )}
      </dl>
      {r?.lossHistory && <LossChart history={r.lossHistory} />}

      {r?.validation?.progress && run.state === "validating" && (
        <p className="mt-1 text-[13px] text-fg-dim">
          Validation images: {r.validation.progress.done} of {r.validation.progress.total}
        </p>
      )}

      <p className="mt-2 text-[12px] text-fg-faint">
        {run.snapshot.items.length} photos · dataset {run.datasetHash.slice(0, 10)} · {run.snapshot.config.maxSteps} steps ·{" "}
        {r?.checkpoints?.length ?? 0} checkpoint{r?.checkpoints?.length === 1 ? "" : "s"}
        {r?.resumedFrom ? ` · resumed from step ${r.resumedFrom}` : ""}
        {run.checkedAt ? ` · checked ${new Date(run.checkedAt).toLocaleTimeString()}` : ""}
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {(run.state === "draft" || run.state === "uploading") && (
          <Button size="sm" variant="primary" disabled={Boolean(busy)} onClick={() => act("upload")}>
            {run.state === "uploading" ? "Continue upload" : "Upload"}
          </Button>
        )}
        {run.state === "uploaded" && (
          <Button size="sm" variant="primary" disabled={Boolean(busy)} onClick={() => act("start")}>
            Start
          </Button>
        )}
        {run.state !== "draft" && run.state !== "removed" && (
          <Button size="sm" disabled={Boolean(busy)} onClick={() => act("status")}>
            {busy === "status" ? "Checking" : "Check status"}
          </Button>
        )}
        {canCancel(run) &&
          (confirm === "cancel" ? (
            <Button size="sm" variant="danger" onClick={() => act("cancel")}>
              Stop this run (checkpoints are kept)
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirm("cancel")}>
              Cancel run
            </Button>
          ))}
        {canResume(run) && (
          <Button size="sm" disabled={Boolean(busy)} onClick={() => act("resume")}>
            Resume from step {r?.resumeStep}
          </Button>
        )}
        {(r?.checkpoints?.length ?? 0) > 0 && (
          <Button size="sm" variant="ghost" onClick={onResults}>
            Compare checkpoints
          </Button>
        )}
        {r?.logTail && (
          <Button size="sm" variant="ghost" onClick={() => setLog(true)}>
            Log
          </Button>
        )}
        {!isActive(run.state) && run.state !== "draft" && run.state !== "removed" && run.state !== "missing" && (
          confirm === "cleanup" ? (
            <Button size="sm" variant="danger" onClick={() => act("cleanup")}>
              Delete this run&apos;s files on the host
            </Button>
          ) : (
            <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirm("cleanup")}>
              Clean up on host
            </Button>
          )
        )}
        {["draft", "completed", "failed", "cancelled", "missing", "removed"].includes(run.state) && (
          <Button size="sm" variant="ghost" onClick={() => deleteRun(run).catch((err: unknown) => notify(String(err)))}>
            Forget run
          </Button>
        )}
      </div>
      {confirm === "cleanup" && (
        <p className="mt-1.5 text-[12.5px] text-fg-faint">
          Removes only {run.remoteDir} on the host: its uploaded photos, checkpoints and validation images. LoRAs you registered stay on
          this computer.
        </p>
      )}
      {log && r?.logTail && <ErrorLogDialog title="Training log (end, secrets removed)" text={r.logTail} onClose={() => setLog(false)} />}
    </li>
  );
}
