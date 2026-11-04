"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useApp } from "@/store/app";
import type { Preflight, Project } from "@/training/api";
import { DIFFUSERS_QWEN_IMAGE_21, derive, hasBlocking, type TrainingConfig } from "@/training/trainers";
import { isHost, useTraining } from "@/training/store";

import { Button, Dialog, Field, NumberInput, Select, TextArea, cx } from "../ui";
import { RunCard } from "./RunCard";

const GiB = 1024 ** 3;

export function TrainPanel({ project, onResults }: { project: Project; onResults: () => void }) {
  const connections = useApp((s) => s.connections);
  const hosts = useMemo(() => connections.filter(isHost), [connections]);
  const hostId = useTraining((s) => s.hostId);
  const setHost = useTraining((s) => s.setHost);
  const runs = useTraining((s) => s.runs);
  const items = useTraining((s) => s.items);
  const saveProject = useTraining((s) => s.saveProject);
  const launch = useTraining((s) => s.launch);
  const pollRuns = useTraining((s) => s.pollRuns);
  const notify = useApp((s) => s.notify);
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0] ?? null;
  const hostState = useTraining((s) => (host ? s.hosts[host.id] : undefined));
  const [config, setConfig] = useState<TrainingConfig>(project.config);
  const [confirming, setConfirming] = useState(false);
  const [launching, setLaunching] = useState(false);

  // On opening: a fresh check of every run that may still be going, then
  // every 15 seconds while any is. Closing the app never stops a run.
  useEffect(() => {
    void pollRuns(hosts);
    const timer = window.setInterval(() => void pollRuns(hosts), 15_000);
    return () => window.clearInterval(timer);
  }, [hosts, pollRuns]);

  const included = items.filter((i) => i.included && !i.decodeError);
  const issues = DIFFUSERS_QWEN_IMAGE_21.validate(config, included.length);
  const derived = derive(config, included.length);
  const dirty = JSON.stringify(config) !== JSON.stringify(project.config);
  const update = (patch: Partial<TrainingConfig>) => setConfig((c) => ({ ...c, ...patch }));

  const preflightBlocks = preflightProblems(hostState?.preflight);
  const canLaunch = Boolean(host) && !hasBlocking(issues) && !dirty && !preflightBlocks.length && Boolean(hostState?.preflight);

  return (
    <div className="grid gap-8 px-6 py-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-6">
        <HostSection project={project} hosts={hosts} hostId={host?.id ?? null} onHost={setHost} />

        <section aria-labelledby="settings-heading">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="settings-heading" className="text-[15px] font-semibold">
              Training settings
            </h2>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setConfig(DIFFUSERS_QWEN_IMAGE_21.preset(project.family, project.triggerToken))}>
                Reset to preset
              </Button>
              <Button
                size="sm"
                variant={dirty ? "primary" : "quiet"}
                disabled={!dirty || hasBlocking(issues.filter((i) => i.field))}
                onClick={() => saveProject(project, { config }).catch((err: unknown) => notify(String(err)))}
              >
                Save settings
              </Button>
            </div>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-fg-dim">
            The identity preset for Qwen-Image 2.1, from the{" "}
            <button type="button" onClick={() => void openUrl(DIFFUSERS_QWEN_IMAGE_21.source)} className="text-safelight hover:text-safelight-strong">
              Diffusers README
            </button>
            :
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] leading-snug text-fg-faint">
            {DIFFUSERS_QWEN_IMAGE_21.presetNotes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>

          <div className="mt-4 grid grid-cols-2 gap-4">
            <Field label="Training steps" htmlFor="cfg-steps" help="Optimizer steps. Checkpoints along the way let you pick an earlier one.">
              <NumberInput id="cfg-steps" value={config.maxSteps} min={1} max={100000} step={50} onChange={(v) => update({ maxSteps: v ?? 1 })} />
            </Field>
            <Field label="Checkpoint and validate every" htmlFor="cfg-ckpt" help="Steps between saved checkpoints.">
              <NumberInput
                id="cfg-ckpt"
                value={config.checkpointSteps}
                min={1}
                step={50}
                onChange={(v) => update({ checkpointSteps: v ?? 1, validationEvery: v ?? 1 })}
              />
            </Field>
          </div>
          <Field
            label="Validation prompts"
            htmlFor="cfg-prompts"
            help={`One per line, up to 8. Each is generated with every validation seed for the base model and each checkpoint. Include ${project.triggerToken}.`}
          >
            <TextArea
              id="cfg-prompts"
              rows={3}
              className="text-[13px]"
              value={config.validationPrompts.join("\n")}
              onChange={(e) => update({ validationPrompts: e.target.value.split("\n").filter((l, i, all) => l.trim() || i < all.length - 1) })}
              onBlur={() => update({ validationPrompts: config.validationPrompts.map((l) => l.trim()).filter(Boolean) })}
            />
          </Field>

          <details className="mt-4 rounded-[4px] border border-line">
            <summary className="cursor-pointer px-3 py-2 text-[13px] font-medium text-fg-dim hover:text-fg">Advanced</summary>
            <AdvancedSettings config={config} update={update} />
          </details>

          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-3">
            <Stat label="Effective batch" value={`${derived.effectiveBatch} (${config.batchSize} × ${config.gradAccum})`} />
            <Stat label="Optimizer steps" value={String(derived.optimizerSteps)} />
            <Stat label="Photos seen" value={`${derived.samplesSeen}`} />
            <Stat label="Passes over the dataset" value={derived.epochs === null ? "No photos yet" : derived.epochs.toFixed(1)} />
            <Stat label="Checkpoints" value={String(derived.checkpoints)} />
            <Stat label="Validation images" value={String(derived.validationImages)} />
          </dl>
          <p className="mt-2 text-[12.5px] text-fg-faint">
            Training time and cost are unknown until a run measures its own pace on your GPU; they are shown then.
          </p>

          {issues.length > 0 && (
            <ul className="mt-3 space-y-1 text-[13px]">
              {issues.map((issue) => (
                <li key={issue.message} className={issue.blocking ? "text-danger" : "text-fg-dim"}>
                  {issue.message}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 flex items-center gap-3">
            <Button variant="primary" disabled={!canLaunch || launching} onClick={() => setConfirming(true)}>
              Review and start training
            </Button>
            <span className="text-[12.5px] text-fg-faint">
              {!host
                ? "Add a GPU host first."
                : dirty
                  ? "Save the settings first."
                  : !hostState?.preflight
                    ? "Check the host first."
                    : preflightBlocks[0] ?? null}
            </span>
          </div>
        </section>
      </div>

      <section aria-labelledby="runs-heading" className="min-w-0">
        <h2 id="runs-heading" className="text-[15px] font-semibold">
          Runs
        </h2>
        <p className="mt-1 text-[13px] text-fg-faint">
          Runs keep going on the host when this app is closed or the connection drops. Status is checked when you open this
          page and every 15 seconds while one is running.
        </p>
        <ul className="mt-3 space-y-3">
          {runs.map((run) => (
            <RunCard key={run.id} run={run} hosts={hosts} onResults={onResults} />
          ))}
          {!runs.length && <li className="text-[13px] text-fg-faint">No runs yet.</li>}
        </ul>
      </section>

      {confirming && host && hostState?.preflight && (
        <LaunchSummary
          project={project}
          config={config}
          hostLabel={host.name}
          preflight={hostState.preflight}
          photoCount={included.length}
          onCancel={() => setConfirming(false)}
          onStart={async () => {
            setConfirming(false);
            setLaunching(true);
            try {
              await launch(host, hostState.preflight?.model?.revision ?? null);
              notify("Training started on the host.");
            } catch (err) {
              notify(err instanceof Error ? err.message : String(err));
            } finally {
              setLaunching(false);
            }
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  );
}

/** What on the host stops a run from starting at all. */
function preflightProblems(p: Preflight | undefined): string[] {
  if (!p) return [];
  const problems: string[] = [];
  if (!p.gpus.length) problems.push("No NVIDIA GPU was found on the host.");
  if (!p.environment.venv || !p.environment.trainerScriptVerified || p.environment.pipeline === false) {
    problems.push("The training environment is not set up.");
  }
  if (p.environment.venv && p.environment.cuda === false) problems.push("PyTorch in the training environment cannot see the GPU.");
  if (p.model && !p.model.downloaded) problems.push("The base model is not downloaded on the host.");
  return problems;
}

function HostSection({
  project,
  hosts,
  hostId,
  onHost,
}: {
  project: Project;
  hosts: ReturnType<typeof useApp.getState>["connections"];
  hostId: string | null;
  onHost: (id: string) => void;
}) {
  const host = hosts.find((h) => h.id === hostId) ?? null;
  const state = useTraining((s) => (hostId ? s.hosts[hostId] : undefined));
  const checkHost = useTraining((s) => s.checkHost);
  const startSetup = useTraining((s) => s.startSetup);
  const checkSetup = useTraining((s) => s.checkSetup);
  const [withModel, setWithModel] = useState(true);
  const setupRunning = state?.setup?.state === "running";

  useEffect(() => {
    if (!host || !setupRunning) return;
    const timer = window.setInterval(() => void checkSetup(host), 10_000);
    return () => window.clearInterval(timer);
  }, [host, setupRunning, checkSetup]);

  if (!hosts.length) {
    return (
      <section className="rounded-[4px] border border-line px-4 py-3 text-[13.5px] leading-relaxed text-fg-dim">
        Training runs on a GPU machine you already have, reached over SSH, such as a RunPod Pod. The app never creates, stops
        or deletes machines.{" "}
        <Link href="/connections" className="text-safelight hover:text-safelight-strong">
          Add a GPU host in Connections
        </Link>
        .
      </section>
    );
  }

  const p = state?.preflight;
  const usedByOthers = p?.gpus.some((g) => g.memoryUsedMiB > 1024) || (p?.processes.length ?? 0) > 0;
  const ourRunning = p?.jobs.filter((j) => j.running) ?? [];

  return (
    <section aria-labelledby="host-heading">
      <div className="flex items-center gap-2">
        <h2 id="host-heading" className="text-[15px] font-semibold">
          GPU host
        </h2>
        <Select value={hostId ?? ""} onChange={(e) => onHost(e.target.value)} className="ml-2 w-auto" aria-label="GPU host">
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!host || state?.checking} onClick={() => host && void checkHost(host)}>
          <RefreshCw size={13} className={cx(state?.checking && "animate-spin")} />
          {state?.checking ? "Checking" : "Check host"}
        </Button>
      </div>
      {state?.error && <p className="mt-2 max-h-32 overflow-y-auto break-words text-[13px] text-danger">{state.error}</p>}

      {p && (
        <div className="mt-3 space-y-2 text-[13px]">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1">
            <dt className="text-fg-faint">GPU</dt>
            <dd>
              {p.gpus.length
                ? p.gpus.map((g) => `${g.name}, ${(g.memoryTotalMiB / 1024).toFixed(0)} GB (${(g.memoryUsedMiB / 1024).toFixed(1)} GB in use), driver ${g.driver}`).join("; ")
                : <span className="text-danger">{p.error ?? "None found"}</span>}
            </dd>
            <dt className="text-fg-faint">Free disk</dt>
            <dd className={cx(p.disk.freeBytes < 80 * GiB && "text-safelight")}>
              {(p.disk.freeBytes / GiB).toFixed(0)} GB of {(p.disk.totalBytes / GiB).toFixed(0)} GB
              {p.disk.freeBytes < 80 * GiB && " (the base model and the training environment need tens of GB)"}
            </dd>
            <dt className="text-fg-faint">Python</dt>
            <dd>{p.python}</dd>
            <dt className="text-fg-faint">Environment</dt>
            <dd>
              {p.environment.venv ? (
                <>
                  {Object.entries(p.environment.packages ?? {})
                    .map(([k, v]) => `${k} ${v ?? "missing"}`)
                    .join(", ")}
                  {p.environment.cuda === false && <span className="text-danger"> · CUDA not available to PyTorch</span>}
                  {p.environment.pipeline === false && <span className="text-danger"> · QwenImage21Pipeline not importable</span>}
                  {!p.environment.trainerScriptVerified && <span className="text-danger"> · training script missing</span>}
                </>
              ) : (
                <span className="text-fg-dim">Not set up</span>
              )}
            </dd>
            <dt className="text-fg-faint">Base model</dt>
            <dd>
              {p.model?.downloaded ? (
                `${p.model.repo} at ${p.model.revision?.slice(0, 10)}`
              ) : (
                <span className="text-fg-dim">
                  {p.model?.repo} not downloaded{p.model?.missing?.length ? ` (missing ${p.model.missing.join(", ")})` : ""}
                </span>
              )}
            </dd>
            {p.loraDir && (
              <>
                <dt className="text-fg-faint">ComfyUI LoRAs</dt>
                <dd className={cx(!(p.loraDir.exists && p.loraDir.writable) && "text-safelight")}>
                  {p.loraDir.path} {p.loraDir.exists ? (p.loraDir.writable ? "" : "(not writable)") : "(does not exist)"}
                </dd>
              </>
            )}
          </dl>
          {usedByOthers && (
            <p className="rounded-[4px] bg-safelight/10 px-3 py-2 leading-snug text-safelight">
              Something else is using this GPU
              {p.processes.length ? `: ${p.processes.map((x) => `${x.name} (${x.memoryMiB} MB)`).join(", ")}` : " (memory is in use)"}. A
              running ComfyUI or another training run competes for memory and can make training fail out of memory. Nothing is
              stopped for you; stop it yourself if you need the memory.
            </p>
          )}
          {ourRunning.length > 0 && (
            <p className="text-fg-dim">
              {ourRunning.length} run{ourRunning.length === 1 ? " is" : "s are"} already running from this app. A new run waits
              (queued) until the GPU is free.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-[4px] border border-line px-3 py-2.5">
            {setupRunning ? (
              <span className="text-safelight">Setting up: {state?.setup?.step ?? "starting"}…</span>
            ) : (
              <>
                <Button size="sm" onClick={() => host && void startSetup(host, withModel ? project.baseModel : null)}>
                  {p.environment.venv ? "Repair environment" : "Set up environment"}
                </Button>
                <label className="flex items-center gap-1.5 text-fg-dim">
                  <input type="checkbox" checked={withModel} onChange={(e) => setWithModel(e.target.checked)} />
                  Download {project.baseModel}
                </label>
              </>
            )}
            <p className="w-full text-[12.5px] leading-snug text-fg-faint">
              Creates its own Python environment under {p.workspace}/env with Diffusers 0.42.1 and the pinned training script.
              ComfyUI&apos;s environment is not touched. Runs in the background on the host; the model download is large.
            </p>
            {state?.setup?.state === "failed" && <p className="w-full text-danger">Setup failed: {state.setup.error}</p>}
            {state?.setupLog && (
              <details className="w-full">
                <summary className="cursor-pointer text-fg-faint">Setup log</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11.5px] text-fg-dim">{state.setupLog}</pre>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function AdvancedSettings({ config, update }: { config: TrainingConfig; update: (patch: Partial<TrainingConfig>) => void }) {
  const num = (key: keyof TrainingConfig, label: string, opts: { step?: number; min?: number; max?: number; help?: string } = {}) => (
    <Field label={label} htmlFor={`adv-${key}`} help={opts.help}>
      <NumberInput
        id={`adv-${key}`}
        value={config[key] as number}
        step={opts.step}
        min={opts.min}
        max={opts.max}
        onChange={(v) => update({ [key]: v ?? 0 } as Partial<TrainingConfig>)}
      />
    </Field>
  );
  const check = (key: keyof TrainingConfig, label: string, help?: string) => (
    <label className="flex items-start gap-2 text-[13px]">
      <input type="checkbox" className="mt-0.5" checked={Boolean(config[key])} onChange={(e) => update({ [key]: e.target.checked } as Partial<TrainingConfig>)} />
      <span>
        <span className="text-fg">{label}</span>
        {help && <span className="block text-[12.5px] text-fg-faint">{help}</span>}
      </span>
    </label>
  );
  return (
    <div className="grid grid-cols-2 gap-4 border-t border-line p-3">
      {num("resolution", "Resolution", { step: 32, min: 256, max: 2048, help: "A multiple of 32. Bucketing keeps each photo's aspect ratio at about this many pixels." })}
      {num("learningRate", "Learning rate", { step: 0.00001, min: 0 })}
      {num("rank", "LoRA rank", { min: 1, max: 256 })}
      {num("alpha", "LoRA alpha", { min: 1, max: 512, help: "Scale is alpha / rank." })}
      {num("batchSize", "Batch size", { min: 1, max: 16 })}
      {num("gradAccum", "Gradient accumulation", { min: 1, max: 64 })}
      {num("seed", "Training seed", { min: 0 })}
      {num("warmupSteps", "Warmup steps", { min: 0 })}
      <Field label="Learning rate schedule" htmlFor="adv-sched">
        <Select id="adv-sched" value={config.lrScheduler} onChange={(e) => update({ lrScheduler: e.target.value as TrainingConfig["lrScheduler"] })}>
          <option value="constant">Constant</option>
          <option value="constant_with_warmup">Constant with warmup</option>
          <option value="linear">Linear</option>
          <option value="cosine">Cosine</option>
        </Select>
      </Field>
      <Field label="Precision" htmlFor="adv-prec">
        <Select id="adv-prec" value={config.precision} onChange={(e) => update({ precision: e.target.value as TrainingConfig["precision"] })}>
          <option value="bf16">bf16</option>
          <option value="fp16">fp16</option>
          <option value="no">fp32</option>
        </Select>
      </Field>
      {num("validationSteps", "Validation sampling steps", { min: 1, max: 100, help: "40 is what the model's docs use." })}
      {num("validationEvery", "Validate every (steps)", { min: 1, help: "A multiple of the checkpoint interval." })}
      <Field label="Validation seeds" htmlFor="adv-seeds" help="Up to 4, comma-separated. Fixed, so checkpoints compare image for image.">
        <input
          id="adv-seeds"
          className="h-8 w-full rounded-[4px] bg-field px-2.5 text-fg"
          defaultValue={config.validationSeeds.join(", ")}
          onBlur={(e) =>
            update({
              validationSeeds: e.target.value
                .split(",")
                .map((s) => Number(s.trim()))
                .filter((n) => Number.isInteger(n) && n >= 0),
            })
          }
        />
      </Field>
      {num("captionDropout", "Caption dropout", { step: 0.05, min: 0, max: 1 })}
      <div className="col-span-2 grid grid-cols-2 gap-3">
        {check("buckets", "Aspect-ratio buckets", "Keeps full-body framing instead of square crops.")}
        {check("use8bitAdam", "8-bit Adam", "bitsandbytes optimizer; less memory.")}
        {check("gradientCheckpointing", "Gradient checkpointing", "Less memory, slower steps.")}
        {check("cacheLatents", "Cache latents", "Encodes photos once, then frees the VAE.")}
        {check("offload", "Offload text encoder and VAE", "To CPU while unused.")}
        {check("quantize4bit", "4-bit base model (NF4)", "The README's bitsandbytes example; for smaller GPUs.")}
        {check("randomFlip", "Random horizontal flip")}
        {check("validationIncludeBase", "Validate the base model too", "Images without the LoRA, for comparison.")}
      </div>
    </div>
  );
}

function LaunchSummary({
  project,
  config,
  hostLabel,
  preflight,
  photoCount,
  onCancel,
  onStart,
}: {
  project: Project;
  config: TrainingConfig;
  hostLabel: string;
  preflight: Preflight;
  photoCount: number;
  onCancel: () => void;
  onStart: () => void;
}) {
  const d = derive(config, photoCount);
  const rows: [string, string][] = [
    ["Dataset", `${photoCount} photos, converted to PNG without metadata, captions as written`],
    ["Model", `${project.baseModel}${preflight.model?.revision ? ` at ${preflight.model.revision.slice(0, 10)}` : ""} (Qwen-Image 2.1)`],
    ["Trainer", DIFFUSERS_QWEN_IMAGE_21.version],
    ["Host", `${hostLabel}: ${preflight.gpus.map((g) => g.name).join(", ")}`],
    ["Output", `${preflight.workspace}/jobs/<run id>/output`],
    ["Settings", `${config.maxSteps} steps, effective batch ${d.effectiveBatch}, rank ${config.rank}/alpha ${config.alpha}, learning rate ${config.learningRate}, ${config.resolution}px${config.buckets ? " with buckets" : ""}`],
    ["Checkpoints", `${d.checkpoints}, every ${config.checkpointSteps} steps; ${d.validationImages} validation images after training`],
  ];
  return (
    <Dialog label="Start training" onClose={onCancel} className="w-[min(640px,100%)] p-6">
      <h2 className="text-[17px] font-semibold">Start training {project.name}?</h2>
      <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-faint">{k}</dt>
            <dd className="text-fg">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-[13px] leading-relaxed text-fg-dim">
        The included photos and the settings are uploaded to {hostLabel}, and the run starts there. It uses the GPU until it
        finishes or you cancel it, and it continues if you close the app.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onStart}>
          Upload and start
        </Button>
      </div>
    </Dialog>
  );
}
