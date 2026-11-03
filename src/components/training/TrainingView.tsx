"use client";

import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useApp } from "@/store/app";
import type { Project } from "@/training/api";
import { TOKEN_PATTERN, TRAINERS, UNSUPPORTED, suggestToken } from "@/training/trainers";
import { isHost, useTraining } from "@/training/store";

import { Button, Dialog, Field, IconButton, TextInput, cx, useFieldId } from "../ui";
import { DatasetPanel } from "./DatasetPanel";
import { ResultsPanel } from "./ResultsPanel";
import { TrainPanel } from "./TrainPanel";

type Tab = "dataset" | "train" | "results";

const TABS: { value: Tab; label: string }[] = [
  { value: "dataset", label: "Photos and captions" },
  { value: "train", label: "Train" },
  { value: "results", label: "Checkpoints and LoRAs" },
];

export function TrainingView() {
  const ready = useApp((s) => s.ready);
  const projects = useTraining((s) => s.projects);
  const loaded = useTraining((s) => s.loaded);
  const projectId = useTraining((s) => s.projectId);
  const loadProjects = useTraining((s) => s.loadProjects);
  const open = useTraining((s) => s.open);
  const notify = useApp((s) => s.notify);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<Tab>("dataset");

  useEffect(() => {
    if (!ready) return;
    loadProjects().catch((err: unknown) => notify(`Could not load training projects: ${String(err)}`));
  }, [ready, loadProjects, notify]);

  const current = projects.find((p) => p.project.id === projectId)?.project ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Training projects" className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <h2 className="text-[13px] font-medium text-fg-dim">Projects</h2>
          <IconButton label="New project" onClick={() => setCreating(true)}>
            <Plus size={16} />
          </IconButton>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {projects.map(({ project, includedCount }) => (
            <li key={project.id}>
              <button
                type="button"
                aria-current={project.id === projectId ? "true" : undefined}
                onClick={() => {
                  setTab("dataset");
                  void open(project.id);
                }}
                className={cx(
                  "flex w-full flex-col rounded-[4px] px-2 py-2 text-left",
                  project.id === projectId ? "bg-raised" : "hover:bg-field",
                )}
              >
                <span className="truncate text-fg">{project.name}</span>
                <span className="text-[12.5px] text-fg-faint">
                  {project.triggerToken} · {includedCount} photo{includedCount === 1 ? "" : "s"} included
                </span>
              </button>
            </li>
          ))}
          {loaded && !projects.length && (
            <li className="px-2 py-2 text-[13px] leading-snug text-fg-faint">
              No projects yet. A project holds the photos of one person and the LoRAs trained from them.
            </li>
          )}
        </ul>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <>
            <ProjectHeader project={current} />
            <nav aria-label="Project steps" className="flex gap-1 border-b border-line px-6">
              {TABS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  aria-current={tab === t.value ? "page" : undefined}
                  onClick={() => setTab(t.value)}
                  className={cx(
                    "relative px-3 py-2 text-[14px]",
                    tab === t.value ? "font-medium text-fg" : "text-fg-dim hover:text-fg",
                  )}
                >
                  {t.label}
                  {tab === t.value && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-safelight" />}
                </button>
              ))}
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tab === "dataset" && <DatasetPanel project={current} />}
              {/* Keyed by the saved settings, so saving or switching projects starts the form from them. */}
              {tab === "train" && <TrainPanel key={`${current.id}-${current.updatedAt}`} project={current} onResults={() => setTab("results")} />}
              {tab === "results" && <ResultsPanel project={current} />}
            </div>
          </>
        ) : (
          <EmptyState onCreate={() => setCreating(true)} />
        )}
      </main>

      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const connections = useApp((s) => s.connections);
  const hosts = useMemo(() => connections.filter(isHost), [connections]);
  return (
    <div className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-[20px] font-semibold">Train a LoRA of yourself</h1>
      <p className="mt-2 leading-relaxed text-fg-dim">
        A personal LoRA keeps one person&apos;s face and proportions consistent across generated images. Add photos of them,
        review the captions, train on your GPU machine, then compare the checkpoints and use the best one in Generate.
      </p>
      <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-fg-dim">
        <li>Create a project and add photographs. They are copied into the app; your originals are not changed.</li>
        <li>Review captions and the training preset.</li>
        <li>Start training on a GPU host you already run, such as a RunPod Pod.</li>
        <li>Compare checkpoints by their validation images.</li>
        <li>Register the one you like and use it with a matching ComfyUI workflow.</li>
      </ol>
      <div className="mt-6 flex items-center gap-3">
        <Button variant="primary" onClick={onCreate}>
          New project
        </Button>
        {!hosts.length && (
          <Link href="/connections" className="text-[13.5px] text-safelight hover:text-safelight-strong">
            Add a GPU host in Connections
          </Link>
        )}
      </div>
    </div>
  );
}

function ProjectHeader({ project }: { project: Project }) {
  const deleteProject = useTraining((s) => s.deleteProject);
  const saveProject = useTraining((s) => s.saveProject);
  const notify = useApp((s) => s.notify);
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [token, setToken] = useState(project.triggerToken);
  const runs = useTraining((s) => s.runs);
  const tokenFixed = runs.length > 0;

  return (
    <header className="flex items-start gap-4 px-6 pb-3 pt-5">
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveProject(project, { name, triggerToken: token })
                .then(() => setEditing(false))
                .catch((err: unknown) => notify(`Could not save: ${String(err)}`));
            }}
          >
            <Field label="Name" htmlFor="project-name">
              <TextInput id="project-name" value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
            </Field>
            <Field label="Trigger token" htmlFor="project-token">
              <TextInput
                id="project-token"
                value={token}
                disabled={tokenFixed}
                onChange={(e) => setToken(e.target.value.trim())}
                className="w-40 font-mono"
              />
            </Field>
            <Button type="submit" variant="primary">
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            {tokenFixed && <p className="w-full text-[12.5px] text-fg-faint">The token is fixed once a run has been made with it.</p>}
          </form>
        ) : (
          <>
            <h1 className="truncate text-[18px] font-semibold">{project.name}</h1>
            <p className="mt-0.5 text-[13px] text-fg-dim">
              Trigger token <code className="text-fg">{project.triggerToken}</code> · Qwen-Image 2.1 · {project.objective}
            </p>
          </>
        )}
      </div>
      {!editing && (
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Rename
          </Button>
          {confirm ? (
            <>
              <Button
                size="sm"
                variant="danger"
                onClick={() => deleteProject(project.id).catch((err: unknown) => notify(`Could not delete: ${String(err)}`))}
              >
                Delete project and its photos
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <IconButton label="Delete project" onClick={() => setConfirm(true)}>
              <Trash2 size={15} />
            </IconButton>
          )}
        </div>
      )}
    </header>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const projects = useTraining((s) => s.projects);
  const createProject = useTraining((s) => s.createProject);
  const taken = useMemo(() => projects.map((p) => p.project.triggerToken.toLowerCase()), [projects]);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameId = useFieldId("project-name");
  const tokenId = useFieldId("project-token");
  const trainer = TRAINERS[0];
  const family = trainer.families[0];
  const suggested = suggestToken(name, taken);
  const effectiveToken = token || suggested;
  const tokenProblem = !TOKEN_PATTERN.test(effectiveToken)
    ? "One word of 3 to 24 letters and digits."
    : taken.includes(effectiveToken.toLowerCase())
      ? "Another project uses this token."
      : null;

  const create = async () => {
    setError(null);
    try {
      await createProject({
        name: name.trim() || "My likeness",
        objective: "Personal identity",
        triggerToken: effectiveToken,
        family: family.id,
        baseModel: family.baseModels[0].repo,
        config: trainer.preset(family.id, effectiveToken),
      });
      onClose();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog label="New training project" onClose={onClose} className="w-[min(560px,100%)] p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2 className="text-[17px] font-semibold">New training project</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-fg-dim">
          One project trains one person. The trigger token is the word you will put in prompts to call them up, so pick
          one that means nothing else.
        </p>
        <div className="mt-5 space-y-4">
          <Field label="Name" htmlFor={nameId}>
            <TextInput id={nameId} value={name} placeholder="My likeness" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Trigger token" htmlFor={tokenId} help={tokenProblem ?? "Used in every caption and validation prompt."}>
            <TextInput
              id={tokenId}
              value={token}
              placeholder={suggested}
              className="font-mono"
              onChange={(e) => setToken(e.target.value.trim())}
            />
          </Field>
          <div className="rounded-[4px] bg-field px-3 py-2.5 text-[13px] leading-snug">
            <p className="text-fg">
              {family.label} with {trainer.label}
            </p>
            <p className="mt-1 text-fg-faint">{trainer.version}. This is the one model and trainer implemented here.</p>
            <details className="mt-2 text-fg-dim">
              <summary className="cursor-pointer text-fg-faint hover:text-fg-dim">Not supported, and why</summary>
              <ul className="mt-1.5 space-y-1">
                {UNSUPPORTED.map((u) => (
                  <li key={u.label}>
                    <span className="text-fg">{u.label}:</span> {u.reason}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
        {error && <p className="mt-4 text-[13px] text-danger">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={Boolean(tokenProblem)}>
            Create project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
