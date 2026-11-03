"use client";

import { Download, FileJson, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { Connection } from "@/providers/types";
import { useApp } from "@/store/app";
import { exportArtifact, imagePath, type Artifact, type Project } from "@/training/api";
import { validationGrid, type RunRecord } from "@/training/jobs";
import { loraOptions, withTrigger, withoutLora } from "@/training/lora";
import { isHost, useTraining } from "@/training/store";

import { Button, Dialog, IconButton, Select, cx } from "../ui";

export function ResultsPanel({ project }: { project: Project }) {
  const runs = useTraining((s) => s.runs);
  const artifacts = useTraining((s) => s.artifacts);
  const withCheckpoints = runs.filter((r) => r.remote?.checkpoints?.length);
  const [runId, setRunId] = useState<string | null>(null);
  const run = withCheckpoints.find((r) => r.id === runId) ?? withCheckpoints[0] ?? null;

  return (
    <div className="space-y-8 px-6 py-5">
      <section aria-labelledby="compare-heading">
        <div className="flex items-center gap-3">
          <h2 id="compare-heading" className="text-[15px] font-semibold">
            Compare checkpoints
          </h2>
          {withCheckpoints.length > 1 && (
            <Select aria-label="Run" value={run?.id ?? ""} onChange={(e) => setRunId(e.target.value)} className="w-auto">
              {withCheckpoints.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.createdAt).toLocaleString()} ({r.state})
                </option>
              ))}
            </Select>
          )}
        </div>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-dim">
          Each column is the same prompts and seeds through a different checkpoint. Choose by how much each looks like the
          person and how well it still follows the prompt. Training loss falls steadily even after a LoRA starts to copy
          its photos, so it is not a good guide to the best checkpoint.
        </p>
        {run ? <Comparison run={run} /> : <p className="mt-3 text-[13px] text-fg-faint">No checkpoints yet.</p>}
      </section>

      <section aria-labelledby="loras-heading">
        <h2 id="loras-heading" className="text-[15px] font-semibold">
          Registered LoRAs
        </h2>
        <ul className="mt-3 space-y-3">
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} artifact={a} project={project} />
          ))}
          {!artifacts.length && <li className="text-[13px] text-fg-faint">Register a checkpoint above to use it.</li>}
        </ul>
      </section>
    </div>
  );
}

function Comparison({ run }: { run: RunRecord }) {
  const connections = useApp((s) => s.connections);
  const hosts = useMemo(() => connections.filter(isHost), [connections]);
  const register = useTraining((s) => s.register);
  const artifacts = useTraining((s) => s.artifacts);
  const busy = useTraining((s) => s.busy[run.id]);
  const notify = useApp((s) => s.notify);
  const [zoom, setZoom] = useState<{ src: string; title: string } | null>(null);
  const grid = validationGrid(run);
  const checkpoints = run.remote?.checkpoints ?? [];
  const host = hosts.find((h) => h.id === run.hostId) ?? null;
  const registered = (step: number) => artifacts.some((a) => a.runId === run.id && a.step === step);
  const columns = grid.labels.length ? grid.labels : checkpoints.map((c) => String(c.step));

  const doRegister = (step: number) => {
    if (!host) return notify(`The host ${run.hostLabel} is no longer in Connections.`);
    register(run, step, host)
      .then(() => notify(`Step ${step} is registered. Install it to use it in ComfyUI.`))
      .catch((err: unknown) => notify(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="border-separate border-spacing-2 text-[12.5px]">
        <thead>
          <tr>
            <th className="w-48 text-left font-normal text-fg-faint">Prompt, seed</th>
            {columns.map((label) => {
              const step = label === "base" ? null : Number(label);
              const checkpoint = checkpoints.find((c) => c.step === step);
              return (
                <th key={label} className="min-w-44 text-left align-bottom font-normal">
                  <span className="block font-medium text-fg">{label === "base" ? "Base model" : `Step ${label}`}</span>
                  {checkpoint && (
                    <span className="block text-fg-faint">
                      {checkpoint.kind === "final" ? "final export" : checkpoint.resumable ? "with training state" : "LoRA only"}
                      {", "}
                      {(checkpoint.size / 2 ** 20).toFixed(0)} MB
                    </span>
                  )}
                  {checkpoint && (
                    <Button
                      size="sm"
                      className="mt-1"
                      disabled={Boolean(busy) || registered(checkpoint.step)}
                      onClick={() => doRegister(checkpoint.step)}
                    >
                      {registered(checkpoint.step) ? "Registered" : busy === "register" ? "Registering" : "Register LoRA"}
                    </Button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.prompts.flatMap((prompt, p) =>
            grid.seeds.map((seed) => (
              <tr key={`${p}-${seed}`}>
                <td className="align-top text-fg-dim">
                  <span className="line-clamp-4" title={prompt}>
                    {prompt}
                  </span>
                  <span className="text-fg-faint">seed {seed}</span>
                </td>
                {columns.map((label) => {
                  const src = grid.cell(label, p, seed);
                  return (
                    <td key={label} className="align-top">
                      {src ? (
                        <button type="button" onClick={() => setZoom({ src, title: `${label === "base" ? "Base model" : `Step ${label}`}, seed ${seed}` })}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={imagePath(src)} alt={`${label}, prompt ${p + 1}, seed ${seed}`} className="size-44 rounded-[3px] object-cover" />
                        </button>
                      ) : (
                        <span className="flex size-44 items-center justify-center rounded-[3px] bg-field text-center text-fg-faint">
                          {run.state === "validating" ? "Being generated" : "No image"}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            )),
          )}
        </tbody>
      </table>
      {!grid.prompts.length && <p className="text-[13px] text-fg-faint">This run had no validation prompts. Register a checkpoint to try it in Generate.</p>}
      {zoom && (
        <Dialog label={zoom.title} onClose={() => setZoom(null)} className="max-h-full p-4">
          <div className="mb-2 flex items-center">
            <h3 className="flex-1 text-[14px] font-medium">{zoom.title}</h3>
            <IconButton label="Close" onClick={() => setZoom(null)}>
              <X size={16} />
            </IconButton>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imagePath(zoom.src)} alt={zoom.title} className="max-h-[calc(100vh-8rem)] max-w-full" />
        </Dialog>
      )}
    </div>
  );
}

function ArtifactCard({ artifact, project }: { artifact: Artifact; project: Project }) {
  const connections = useApp((s) => s.connections);
  const hosts = useMemo(() => connections.filter(isHost), [connections]);
  const comfys = useMemo(() => connections.filter((c) => c.kind === "comfyui"), [connections]);
  const install = useTraining((s) => s.install);
  const deleteArtifact = useTraining((s) => s.deleteArtifact);
  const busy = useTraining((s) => s.busy[artifact.runId]);
  const notify = useApp((s) => s.notify);
  const selectConnection = useApp((s) => s.selectConnection);
  const router = useRouter();
  const [hostId, setHostId] = useState(hosts.find((h) => h.config.loraDir)?.id ?? hosts[0]?.id ?? "");
  const [using, setUsing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const host = hosts.find((h) => h.id === hostId) ?? null;
  const manifest = artifact.manifest as { settings?: { rank?: number; alpha?: number; learningRate?: number; maxSteps?: number }; datasetSize?: number; baseRevision?: string; trainerVersion?: string };

  const doExport = (manifestOnly: boolean) =>
    exportArtifact(artifact.id, manifestOnly)
      .then((path) => path && notify(`Saved to ${path}${manifestOnly ? "" : " with its manifest next to it"}.`))
      .catch((err: unknown) => notify(String(err)));

  return (
    <li className="rounded-[5px] border border-line bg-panel p-3.5 text-[13px]">
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-fg">
          {project.name}, step {artifact.step}
        </span>
        <span className="text-fg-faint">Qwen-Image 2.1 · trigger {artifact.triggerToken}</span>
        <IconButton label="Delete this LoRA" className="ml-auto" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 text-fg-dim">
        <dt className="text-fg-faint">Base model</dt>
        <dd>
          {artifact.baseModel}
          {manifest.baseRevision ? ` at ${manifest.baseRevision.slice(0, 10)}` : ""}
        </dd>
        <dt className="text-fg-faint">Trainer</dt>
        <dd>{manifest.trainerVersion ?? artifact.trainer}</dd>
        <dt className="text-fg-faint">Settings</dt>
        <dd>
          rank {manifest.settings?.rank}, alpha {manifest.settings?.alpha}, learning rate {manifest.settings?.learningRate}, {manifest.settings?.maxSteps} steps
        </dd>
        <dt className="text-fg-faint">Dataset</dt>
        <dd>
          {manifest.datasetSize} photos, snapshot {artifact.datasetHash.slice(0, 12)}
        </dd>
        <dt className="text-fg-faint">File</dt>
        <dd className="break-all">
          {(artifact.size / 2 ** 20).toFixed(1)} MB, SHA-256 {artifact.sha256}
        </dd>
        <dt className="text-fg-faint">Installed</dt>
        <dd>{artifact.installs.length ? artifact.installs.map((i) => `${i.hostLabel}: ${i.dir}/${i.fileName}`).join("; ") : "Not yet"}</dd>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => void doExport(false)}>
          <Download size={13} />
          Save LoRA
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void doExport(true)}>
          <FileJson size={13} />
          Save manifest
        </Button>
        {hosts.length > 0 && (
          <span className="ml-2 flex items-center gap-1.5">
            <Select aria-label="Host to install on" value={hostId} onChange={(e) => setHostId(e.target.value)} className="h-7 w-auto text-[12.5px]">
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              disabled={!host?.config.loraDir || Boolean(busy)}
              title={host?.config.loraDir ? undefined : "Set ComfyUI's LoRA folder on this host's connection"}
              onClick={() =>
                host &&
                install(artifact, host)
                  .then(() => notify(`Installed in ${host.config.loraDir}. Refresh the model list in Generate to see it.`))
                  .catch((err: unknown) => notify(err instanceof Error ? err.message : String(err)))
              }
            >
              {busy === "install" ? "Installing" : "Install for ComfyUI"}
            </Button>
          </span>
        )}
        <Button size="sm" variant="primary" disabled={!artifact.installs.length || !comfys.length} onClick={() => setUsing(true)}>
          Use in Generate
        </Button>
      </div>
      {!comfys.length && <p className="mt-1.5 text-fg-faint">Using it needs a ComfyUI connection to the host it is installed on.</p>}
      <p className="mt-1.5 text-fg-faint">Exports never include your photographs or any credential.</p>

      {confirmDelete && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="danger" onClick={() => deleteArtifact(artifact.id).catch((err: unknown) => notify(String(err)))}>
            Delete this computer&apos;s copy
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            Keep
          </Button>
          <span className="text-fg-faint">Installed copies on hosts are left in place.</span>
        </div>
      )}

      {using && (
        <UseInGenerate
          artifact={artifact}
          comfys={comfys}
          onClose={() => setUsing(false)}
          onUse={(connectionId, fileName, insertTrigger) => {
            selectConnection(connectionId);
            const { form, setForm } = useApp.getState();
            setForm({
              options: { ...withoutLora(form.options), ...loraOptions(artifact, fileName, 1) },
              ...(insertTrigger ? { prompt: withTrigger(form.prompt, artifact.triggerToken) } : {}),
            });
            setUsing(false);
            router.push("/");
          }}
        />
      )}
    </li>
  );
}

function UseInGenerate({
  artifact,
  comfys,
  onClose,
  onUse,
}: {
  artifact: Artifact;
  comfys: Connection[];
  onClose: () => void;
  onUse: (connectionId: string, fileName: string, insertTrigger: boolean) => void;
}) {
  const [connectionId, setConnectionId] = useState(comfys[0]?.id ?? "");
  const [install, setInstall] = useState(0);
  const [insertTrigger, setInsertTrigger] = useState(true);
  const chosen = artifact.installs[install];
  return (
    <Dialog label="Use in Generate" onClose={onClose} className="w-[min(520px,100%)] p-6">
      <h2 className="text-[17px] font-semibold">Use this LoRA in Generate</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-fg-dim">
        It goes into the LoRA loader of the workflow you run. Generate checks that the workflow loads Qwen-Image 2.1 and has a
        LoRA loader, and says what is missing if not.
      </p>
      <div className="mt-4 space-y-3 text-[13px]">
        <label className="block">
          <span className="text-fg-dim">ComfyUI connection</span>
          <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="mt-1">
            {comfys.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="text-fg-dim">Installed copy it should load</span>
          <Select value={String(install)} onChange={(e) => setInstall(Number(e.target.value))} className="mt-1">
            {artifact.installs.map((i, n) => (
              <option key={`${i.hostId}-${i.fileName}`} value={n}>
                {i.hostLabel}: {i.fileName}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-fg-dim">
          <input type="checkbox" checked={insertTrigger} onChange={(e) => setInsertTrigger(e.target.checked)} />
          Add &quot;{artifact.triggerToken}&quot; to the prompt if it is not there
        </label>
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!connectionId || !chosen} onClick={() => chosen && onUse(connectionId, chosen.fileName, insertTrigger)}>
          Open Generate
        </Button>
      </div>
      <p className={cx("mt-3 text-[12.5px] text-fg-faint")}>The ComfyUI connection must be the one running on that host.</p>
    </Dialog>
  );
}
