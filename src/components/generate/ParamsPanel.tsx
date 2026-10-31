"use client";

import { ArrowLeftRight, Dices, FileUp, Paintbrush, RefreshCw, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { boundInput, fieldKey, type SavedWorkflow, type WorkflowBinding } from "@/providers/comfy-workflow";
import { provider } from "@/providers/registry";
import type { OptionField } from "@/providers/types";
import { activeConnection, activeWorkflow, capabilitiesFor, effectiveMode, useApp, type FormState } from "@/store/app";

import { PromptHelper } from "../PromptHelper";
import { Button, Field, IconButton, NumberInput, Segmented, Select, TextArea, TextInput, cx, useFieldId } from "../ui";
import { ImageDrop } from "./ImageDrop";
import { MaskEditor } from "./MaskEditor";
import { PromptBox } from "./PromptBox";
import { WorkflowEditor } from "./WorkflowEditor";

const ASPECTS: [number, number][] = [
  [1, 1],
  [4, 3],
  [3, 4],
  [3, 2],
  [2, 3],
  [16, 9],
  [9, 16],
];

function useElapsed(since: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

function OptionInput({
  field,
  value,
  onChange,
}: {
  field: OptionField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useFieldId(field.key);
  return (
    <Field label={field.label} help={field.help} htmlFor={id}>
      {field.type === "select" ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : field.type === "json" ? (
        <TextArea
          id={id}
          rows={3}
          spellCheck={false}
          value={value}
          placeholder="{}"
          onChange={(e) => onChange(e.target.value)}
          className="text-[13px]"
        />
      ) : (
        <TextInput
          id={id}
          type={field.type === "number" ? "number" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** An input of an imported workflow shown as-is in the panel. */
function WorkflowField({
  workflow,
  binding,
  value,
  choices,
  onChange,
}: {
  workflow: SavedWorkflow;
  binding: WorkflowBinding;
  value: string;
  choices?: string[];
  onChange: (value: string) => void;
}) {
  const id = useFieldId("wf");
  const original = workflow.graph[binding.nodeId]?.inputs[binding.input];
  const label = binding.label || binding.input;
  const node = workflow.graph[binding.nodeId];
  const help = node ? `${node._meta?.title || node.class_type}, input ${binding.input}` : undefined;
  return (
    <Field label={label} htmlFor={id} help={help}>
      {choices?.length ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {!choices.includes(value) && <option value={value}>{value}</option>}
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      ) : typeof original === "boolean" ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="true">On</option>
          <option value="false">Off</option>
        </Select>
      ) : typeof original === "string" && (original.length > 60 || original.includes("\n")) ? (
        <TextArea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} className="text-[13.5px]" />
      ) : (
        <TextInput
          id={id}
          type={typeof original === "number" ? "number" : "text"}
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function ParamsPanel() {
  const form = useApp((s) => s.form);
  const setForm = useApp((s) => s.setForm);
  const connection = useApp(activeConnection);
  const workflow = useApp(activeWorkflow);
  const workflows = useApp((s) => s.workflows);
  const choices = useApp((s) => (connection ? s.choices[connection.id] : undefined));
  const loadChoices = useApp((s) => s.loadChoices);
  const setInputFromFile = useApp((s) => s.setInputFromFile);
  const importWorkflow = useApp((s) => s.importWorkflow);
  const selectWorkflow = useApp((s) => s.selectWorkflow);
  const job = useApp((s) => s.job);
  const generate = useApp((s) => s.generate);
  const cancel = useApp((s) => s.cancel);
  const dismissJob = useApp((s) => s.dismissJob);
  const running = job?.status === "running";
  const elapsed = useElapsed(running ? job.startedAt : undefined);
  const [paintingMask, setPaintingMask] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<SavedWorkflow | null>(null);
  const workflowFileRef = useRef<HTMLInputElement>(null);

  const promptId = useFieldId("prompt");
  const negativeId = useFieldId("negative");
  const modelId = useFieldId("model");
  const listId = useFieldId("models");
  const countId = useFieldId("count");
  const seedId = useFieldId("seed");
  const stepsId = useFieldId("steps");
  const cfgId = useFieldId("cfg");
  const samplerId = useFieldId("sampler");
  const schedulerId = useFieldId("scheduler");
  const workflowId = useFieldId("workflow");

  if (!connection) {
    return (
      <aside className="flex w-[360px] shrink-0 flex-col justify-center gap-3 border-r border-line bg-panel px-6">
        <p className="text-fg">No backend connected yet.</p>
        <p className="text-fg-dim">
          Add OpenAI, OpenRouter, ComfyUI, RunPod, fal.ai, Replicate or a Stable Diffusion WebUI to start generating.
        </p>
        <Link
          href="/connections"
          className="inline-flex h-8 items-center self-start rounded-[4px] bg-safelight px-3 font-semibold text-safelight-ink hover:bg-safelight-strong"
        >
          Add a connection
        </Link>
      </aside>
    );
  }

  const def = provider(connection.kind);
  const caps = capabilitiesFor(connection, workflow)!;
  const mode = effectiveMode(form, caps);
  const set = <K extends keyof FormState>(key: K) => (value: FormState[K]) => setForm({ [key]: value } as Partial<FormState>);
  const setOption = (key: string, value: string) => setForm({ options: { ...form.options, [key]: value } });
  const stepsOptional = def.defaults?.steps === 0;
  const promptShown = !workflow || workflow.bindings.some((b) => b.target === "prompt");
  const fieldBindings = workflow?.bindings.filter((b) => b.target === "field") ?? [];
  const inputChoices = (classType: string | undefined, input: string) =>
    classType ? choices?.inputs?.[`${classType}.${input}`] : undefined;

  const modelInput = workflow ? boundInput(workflow, "model") : null;
  const modelChoices = modelInput
    ? (inputChoices(modelInput.classType, modelInput.input) ?? []).map((value) => ({ value, label: undefined }))
    : (choices?.models ?? def.suggestedModels.map((value) => ({ value, label: undefined })));
  const modelPlaceholder = workflow
    ? String(workflow.graph[workflow.bindings.find((b) => b.target === "model")?.nodeId ?? ""]?.inputs[modelInput?.input ?? ""] ?? "")
    : def.defaultModel(connection.config);

  const applyAspect = (a: number, b: number) => {
    const area = form.width * form.height;
    const step = caps.sizeStep;
    const width = Math.round(Math.sqrt((area * a) / b) / step) * step;
    const height = Math.round(width * (b / a) / step) * step;
    setForm({ width, height });
  };
  const ratio = form.width / form.height;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-6 pt-4">
        {def.supportsWorkflows && (
          <Field
            label="Workflow"
            htmlFor={workflowId}
            aside={
              <span className="flex items-center gap-0.5">
                {workflow && (
                  <IconButton label="Choose which inputs the panel controls" onClick={() => setEditingWorkflow(workflow)}>
                    <SlidersHorizontal size={14} />
                  </IconButton>
                )}
                <IconButton label="Import a workflow (API format JSON)" onClick={() => workflowFileRef.current?.click()}>
                  <FileUp size={14} />
                </IconButton>
              </span>
            }
          >
            <input
              ref={workflowFileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Workflow file"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const imported = await importWorkflow(file);
                if (imported) setEditingWorkflow(imported);
              }}
            />
            <Select id={workflowId} value={workflow?.id ?? ""} onChange={(e) => selectWorkflow(e.target.value || null)}>
              <option value="">Built-in (checkpoint)</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {promptShown && (
          <Field
            label="Prompt"
            htmlFor={promptId}
            aside={
              <PromptHelper
                prompt={form.prompt}
                negativePrompt={form.negativePrompt}
                target={{
                  backend: def.label,
                  model: form.model.trim() || (workflow ? workflow.name : def.defaultModel(connection.config)),
                  negative: caps.negativePrompt,
                  purpose: "image",
                  references: form.references.length,
                }}
                onChange={(next) =>
                  setForm({ prompt: next.prompt, ...(next.negativePrompt !== undefined ? { negativePrompt: next.negativePrompt } : {}) })
                }
              />
            }
          >
            <PromptBox
              id={promptId}
              value={form.prompt}
              onChange={set("prompt")}
              references={form.references}
              limit={caps.references}
              backend={def.label}
            />
          </Field>
        )}

        {caps.negativePrompt && (
          <Field label="Avoid" htmlFor={negativeId}>
            <TextArea
              id={negativeId}
              rows={2}
              value={form.negativePrompt}
              onChange={(e) => set("negativePrompt")(e.target.value)}
              placeholder="Things to keep out of the image"
              className="font-serif text-[15px] leading-[1.45]"
            />
          </Field>
        )}

        {caps.img2img && !caps.img2imgOnly && (
          <Segmented
            label="Mode"
            value={mode}
            onChange={set("mode")}
            options={[
              { value: "txt2img", label: "Text to image" },
              { value: "img2img", label: def.kind === "openai" ? "Edit image" : "Image to image" },
            ]}
          />
        )}

        {mode === "img2img" && (
          <div className="space-y-4">
            <ImageDrop
              label="Input image"
              image={form.initImage}
              hint="Drop, paste or choose the image to start from"
              onFile={(file) => void setInputFromFile(file, "initImage")}
              onClear={() => setForm({ initImage: null, mask: null })}
            />
            {caps.strength && (
              <Field
                label="Change amount"
                aside={<span className="text-[13px] text-fg-dim">{Math.round(form.strength * 100)}%</span>}
                help="Low keeps the input's composition; high follows the prompt."
              >
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={form.strength}
                  aria-label="Change amount"
                  onChange={(e) => set("strength")(Number(e.target.value))}
                />
              </Field>
            )}
            {caps.mask && form.initImage && (
              <Field
                label="Area to change"
                aside={
                  <Button variant="ghost" size="sm" onClick={() => setPaintingMask(true)}>
                    <Paintbrush size={14} />
                    {form.mask ? "Edit mask" : "Paint mask"}
                  </Button>
                }
              >
                <ImageDrop
                  label="Mask"
                  image={form.mask}
                  hint="Optional. Paint it, or drop a mask where white or transparent marks the area"
                  onFile={(file) => void setInputFromFile(file, "mask")}
                  onClear={() => setForm({ mask: null })}
                />
              </Field>
            )}
          </div>
        )}

        {caps.model && (
          <Field
            label="Model"
            htmlFor={modelId}
            aside={
              (def.listModels || def.listSamplers) && (
                <IconButton
                  label="Reload models from the backend"
                  onClick={() => void loadChoices(connection.id)}
                  disabled={choices?.loading}
                >
                  <RefreshCw size={14} className={cx(choices?.loading && "animate-spin")} />
                </IconButton>
              )
            }
            help={choices?.error ? <span className="text-danger">Could not load models: {choices.error}</span> : undefined}
          >
            <TextInput
              id={modelId}
              list={listId}
              value={form.model}
              onChange={(e) => set("model")(e.target.value)}
              placeholder={modelPlaceholder || "Choose a model"}
              spellCheck={false}
            />
            <datalist id={listId}>
              {modelChoices.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </datalist>
          </Field>
        )}

        {caps.size && (
          <Field label="Size" aside={<span className="text-[12.5px] text-fg-faint">multiples of {caps.sizeStep}</span>}>
            <div className="grid grid-cols-7 gap-1">
              {ASPECTS.map(([a, b]) => {
                const active = Math.abs(Math.log(ratio / (a / b))) < 0.02;
                return (
                  <button
                    key={`${a}:${b}`}
                    type="button"
                    onClick={() => applyAspect(a, b)}
                    aria-pressed={active}
                    aria-label={`Aspect ratio ${a}:${b}`}
                    className={cx(
                      "flex h-11 flex-col items-center justify-center gap-1 rounded-[4px] text-[12px] transition-colors",
                      active ? "bg-raised text-fg" : "text-fg-dim hover:bg-field hover:text-fg",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cx("inline-block border", active ? "border-safelight" : "border-fg-faint")}
                      style={{ width: a >= b ? 12 : (12 * a) / b, height: b >= a ? 12 : (12 * b) / a }}
                    />
                    {a}:{b}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5">
              <NumberInput ariaLabel="Width" value={form.width} onChange={(v) => set("width")(v ?? 1024)} min={64} step={caps.sizeStep} />
              <IconButton
                label="Swap width and height"
                onClick={() => setForm({ width: form.height, height: form.width })}
                className="shrink-0"
              >
                <ArrowLeftRight size={14} />
              </IconButton>
              <NumberInput ariaLabel="Height" value={form.height} onChange={(v) => set("height")(v ?? 1024)} min={64} step={caps.sizeStep} />
            </div>
          </Field>
        )}

        {(caps.maxCount > 1 || caps.seed) && (
          <div className="grid grid-cols-2 gap-3">
            {caps.maxCount > 1 && (
              <Field label="Images" htmlFor={countId}>
                <NumberInput
                  id={countId}
                  value={form.count}
                  onChange={(v) => set("count")(Math.min(Math.max(1, v ?? 1), caps.maxCount))}
                  min={1}
                  max={caps.maxCount}
                />
              </Field>
            )}
            {caps.seed && (
              <Field
                label="Seed"
                htmlFor={seedId}
                aside={
                  <IconButton
                    label="Pick a random seed and keep it"
                    onClick={() => set("seed")(crypto.getRandomValues(new Uint32Array(1))[0])}
                    className="-my-1 size-6"
                  >
                    <Dices size={14} />
                  </IconButton>
                }
              >
                <NumberInput id={seedId} value={form.seed} onChange={set("seed")} placeholder="Random" allowEmpty min={0} />
              </Field>
            )}
          </div>
        )}

        {(caps.steps || caps.cfg) && (
          <div className="grid grid-cols-2 gap-3">
            {caps.steps && (
              <Field label="Steps" htmlFor={stepsId}>
                <NumberInput
                  id={stepsId}
                  value={stepsOptional && !form.steps ? null : form.steps}
                  onChange={(v) => set("steps")(v ?? 0)}
                  allowEmpty={stepsOptional}
                  placeholder="Model default"
                  min={stepsOptional ? 0 : 1}
                  max={200}
                />
              </Field>
            )}
            {caps.cfg && (
              <Field label="Guidance" htmlFor={cfgId}>
                <NumberInput
                  id={cfgId}
                  value={stepsOptional && !form.cfg ? null : form.cfg}
                  onChange={(v) => set("cfg")(v ?? 0)}
                  allowEmpty={stepsOptional}
                  placeholder="Model default"
                  min={0}
                  max={30}
                  step={0.5}
                />
              </Field>
            )}
          </div>
        )}

        {(caps.sampler || caps.scheduler) && (
          <div className="grid grid-cols-2 gap-3">
            {caps.sampler && (
              <Field label="Sampler" htmlFor={samplerId}>
                {choices?.samplers?.length ? (
                  <Select id={samplerId} value={form.sampler} onChange={(e) => set("sampler")(e.target.value)}>
                    {!choices.samplers.includes(form.sampler) && <option value={form.sampler}>{form.sampler || "Default"}</option>}
                    {choices.samplers.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput id={samplerId} value={form.sampler} onChange={(e) => set("sampler")(e.target.value)} placeholder="euler" />
                )}
              </Field>
            )}
            {caps.scheduler && (
              <Field label="Scheduler" htmlFor={schedulerId}>
                {choices?.schedulers?.length ? (
                  <Select id={schedulerId} value={form.scheduler} onChange={(e) => set("scheduler")(e.target.value)}>
                    {!choices.schedulers.includes(form.scheduler) && (
                      <option value={form.scheduler}>{form.scheduler || "Default"}</option>
                    )}
                    {choices.schedulers.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput id={schedulerId} value={form.scheduler} onChange={(e) => set("scheduler")(e.target.value)} placeholder="normal" />
                )}
              </Field>
            )}
          </div>
        )}

        {workflow &&
          fieldBindings.map((binding) => (
            <WorkflowField
              key={fieldKey(binding)}
              workflow={workflow}
              binding={binding}
              value={form.options[fieldKey(binding)] ?? String(workflow.graph[binding.nodeId]?.inputs[binding.input] ?? "")}
              choices={inputChoices(workflow.graph[binding.nodeId]?.class_type, binding.input)}
              onChange={(value) => setOption(fieldKey(binding), value)}
            />
          ))}

        {def.options
          .filter((o) => !o.mode || o.mode === mode)
          .map((option) => (
            <OptionInput
              key={option.key}
              field={option}
              value={form.options[option.key] ?? option.default}
              onChange={(value) => setOption(option.key, value)}
            />
          ))}
      </div>

      <div className="border-t border-line bg-panel px-4 py-3">
        {job?.status === "error" && (
          <div role="alert" className="mb-3 max-h-36 overflow-y-auto rounded-[4px] bg-danger/10 px-3 py-2 text-[13px] leading-snug text-danger">
            <p>{job.error}</p>
            <button type="button" onClick={dismissJob} className="mt-1 text-fg-dim hover:text-fg">
              Dismiss
            </button>
          </div>
        )}
        {running ? (
          <div className="flex items-center gap-2">
            <Button className="h-10 flex-1" onClick={cancel}>
              Cancel
            </Button>
            <span className="w-14 text-right text-[13px] text-fg-dim">{elapsed}s</span>
          </div>
        ) : (
          <Button variant="primary" className="h-10 w-full rounded-[6px] text-[15px]" onClick={() => void generate()}>
            Generate
            <kbd className="ml-1 font-sans text-[12px] font-medium opacity-60">Ctrl Enter</kbd>
          </Button>
        )}
      </div>

      {paintingMask && form.initImage && (
        <MaskEditor
          image={form.initImage}
          mask={form.mask}
          onSave={(mask) => setForm({ mask })}
          onClose={() => setPaintingMask(false)}
        />
      )}
      {editingWorkflow && <WorkflowEditor workflow={editingWorkflow} onClose={() => setEditingWorkflow(null)} />}
    </aside>
  );
}
