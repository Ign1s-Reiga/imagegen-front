"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { loraLoader, type SavedWorkflow } from "@/providers/comfy-workflow";
import type { ImageConnection } from "@/providers/types";
import { useApp, type FormState } from "@/store/app";
import { listArtifacts, type Artifact } from "@/training/api";
import { LORA_OPTIONS, loraChoice, loraFit, loraOptions, trainedLoraMeta, withTrigger, withoutLora } from "@/training/lora";

import { Field, IconButton, NumberInput, Select, cx, useFieldId } from "../ui";

/**
 * Choosing a LoRA trained in the Training area for a ComfyUI workflow. Shown
 * for ComfyUI only: other backends cannot load a LoRA file from here.
 */
export function LoraSection({
  connection,
  workflow,
  form,
  setForm,
  listed,
}: {
  connection: ImageConnection;
  workflow: SavedWorkflow | null;
  form: FormState;
  setForm: (patch: Partial<FormState>) => void;
  /** The LoRA files ComfyUI lists for the workflow's loader, when known. */
  listed: string[] | undefined;
}) {
  const loadChoices = useApp((s) => s.loadChoices);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const id = useFieldId("lora");
  const strengthId = useFieldId("lora-strength");
  const meta = trainedLoraMeta(form.options);
  const choice = loraChoice(form.options);
  const loader = workflow ? loraLoader(workflow) : null;

  useEffect(() => {
    listArtifacts()
      .then(setArtifacts)
      .catch(() => setArtifacts([]));
  }, []);

  if (connection.kind !== "comfyui") return null;
  // Nothing to offer: no LoRA loader, and none chosen to explain.
  if (!loader && !choice) return null;

  const installed = (artifacts ?? []).flatMap((a) => a.installs.map((install) => ({ artifact: a, install })));
  const value = choice ? `${meta?.id ?? ""}|${choice.name}` : "";
  const fit = meta && choice ? loraFit(meta, connection.kind, workflow, form.model.trim()) : null;
  const notListed = choice && listed && !listed.includes(choice.name);

  return (
    <Field
      label="Trained LoRA"
      htmlFor={id}
      aside={
        <IconButton label="Refresh the LoRA files ComfyUI lists" onClick={() => void loadChoices(connection.id)}>
          <RefreshCw size={13} />
        </IconButton>
      }
      help={
        <>
          {fit && !fit.ok && <span className="text-danger">{fit.reason}</span>}
          {fit?.ok && `Loads into ${fit.loaderTitle}.`}
          {notListed && (
            <span className={cx("block", "text-safelight")}>
              ComfyUI does not list {choice.name} yet. Refresh after installing it on the host this ComfyUI runs on.
            </span>
          )}
          {!choice && (
            <>
              None chosen: the workflow&apos;s own LoRA setting is used.{" "}
              {!installed.length && (
                <Link href="/training" className="text-safelight hover:text-safelight-strong">
                  Train one
                </Link>
              )}
            </>
          )}
        </>
      }
    >
      <Select
        id={id}
        value={value}
        onChange={(e) => {
          const picked = installed.find(({ artifact, install }) => `${artifact.id}|${install.fileName}` === e.target.value);
          setForm({ options: picked ? { ...withoutLora(form.options), ...loraOptions(picked.artifact, picked.install.fileName, choice?.strength ?? 1) } : withoutLora(form.options) });
        }}
      >
        <option value="">None</option>
        {installed.map(({ artifact, install }) => (
          <option key={`${artifact.id}|${install.fileName}`} value={`${artifact.id}|${install.fileName}`}>
            {install.fileName} ({install.hostLabel})
          </option>
        ))}
        {choice && !installed.some(({ artifact, install }) => `${artifact.id}|${install.fileName}` === value) && (
          <option value={value}>{choice.name}</option>
        )}
      </Select>
      {choice && (
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor={strengthId} className="text-[13px] text-fg-dim">
            Strength
          </label>
          <NumberInput
            id={strengthId}
            value={choice.strength}
            step={0.05}
            min={-2}
            max={2}
            className="w-24"
            onChange={(v) => setForm({ options: { ...form.options, [LORA_OPTIONS.strength]: String(v ?? 1) } })}
          />
          {meta && (
            <button
              type="button"
              className="ml-auto text-[12.5px] text-safelight hover:text-safelight-strong disabled:text-fg-faint"
              disabled={withTrigger(form.prompt, meta.triggerToken) === form.prompt}
              onClick={() => setForm({ prompt: withTrigger(form.prompt, meta.triggerToken) })}
            >
              Add {meta.triggerToken} to the prompt
            </button>
          )}
        </div>
      )}
    </Field>
  );
}
