"use client";

import { useMemo, useState } from "react";

import {
  WORKFLOW_PARAMS,
  editableInputs,
  nodeTitle,
  workflowDefaults,
  type Primitive,
  type SavedWorkflow,
  type WorkflowBinding,
} from "@/providers/comfy-workflow";
import { useApp } from "@/store/app";

import { Button, Dialog, TextInput } from "../ui";

type Target = WorkflowBinding["target"] | "";

const preview = (value: Primitive) => {
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 48)}…` : text || "(empty)";
};

/** Choose which workflow inputs the parameter panel controls. */
export function WorkflowEditor({ workflow, onClose }: { workflow: SavedWorkflow; onClose: () => void }) {
  const saveWorkflow = useApp((s) => s.saveWorkflow);
  const deleteWorkflow = useApp((s) => s.deleteWorkflow);
  const setForm = useApp((s) => s.setForm);
  const notify = useApp((s) => s.notify);
  const [name, setName] = useState(workflow.name);
  const [bindings, setBindings] = useState<WorkflowBinding[]>(workflow.bindings);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const groups = useMemo(() => editableInputs(workflow.graph), [workflow.graph]);

  const find = (nodeId: string, input: string) => bindings.find((b) => b.nodeId === nodeId && b.input === input);

  const setTarget = (nodeId: string, input: string, target: Target) => {
    const rest = bindings.filter((b) => !(b.nodeId === nodeId && b.input === input));
    setBindings(target ? [...rest, { nodeId, input, target, label: find(nodeId, input)?.label }] : rest);
  };

  const setLabel = (nodeId: string, input: string, label: string) =>
    setBindings(bindings.map((b) => (b.nodeId === nodeId && b.input === input ? { ...b, label } : b)));

  const save = async () => {
    const updated = { ...workflow, name: name.trim() || workflow.name, bindings };
    await saveWorkflow(updated);
    // Newly shown fields start at their saved values; values already edited stay.
    const { form } = useApp.getState();
    if (form.options.workflow === workflow.id) {
      setForm({ options: { ...workflowDefaults(updated).options, ...form.options } });
    }
    notify("Workflow saved");
    onClose();
  };

  const controlled = bindings.filter((b) => b.target !== "field").length;
  const fields = bindings.filter((b) => b.target === "field").length;

  return (
    <Dialog
      label="Workflow inputs"
      onClose={onClose}
      initialFocus="panel"
      closeOnBackdrop={false}
      className="flex max-h-[88vh] w-full max-w-[820px] flex-col border border-line"
    >
      <div className="border-b border-line px-6 pb-4 pt-5">
        <h2 className="text-[17px] font-semibold">Workflow inputs</h2>
        <p className="mt-1 max-w-[62ch] text-fg-dim">
          Choose what the parameter panel controls. Anything left on its saved value runs exactly as exported.
        </p>
        <label className="mt-4 flex items-center gap-3 text-[13px] text-fg-dim">
          Name
          <TextInput value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm" />
        </label>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {groups.map(({ nodeId, node, inputs }) => (
          <section key={nodeId} className="border-b border-line py-3 last:border-b-0">
            <h3 className="flex items-baseline gap-2">
              <span className="font-medium text-fg">{nodeTitle(node)}</span>
              {nodeTitle(node) !== node.class_type && (
                <span className="text-[12.5px] text-fg-faint">{node.class_type}</span>
              )}
              <span className="text-[12.5px] text-fg-faint">#{nodeId}</span>
            </h3>
            <div className="mt-2 space-y-1.5">
              {inputs.map(({ input, value }) => {
                const binding = find(nodeId, input);
                const kind = typeof value === "number" ? "number" : typeof value === "string" ? "string" : null;
                const id = `wf-${nodeId}-${input}`;
                return (
                  <div key={input} className="grid grid-cols-[150px_1fr_230px] items-center gap-3">
                    <label htmlFor={id} className="truncate text-[13px] text-fg-dim" title={input}>
                      {input}
                    </label>
                    <span className="truncate text-[13px] text-fg-faint" title={String(value)}>
                      {preview(value)}
                    </span>
                    <select
                      id={id}
                      value={binding?.target ?? ""}
                      onChange={(e) => setTarget(nodeId, input, e.target.value as Target)}
                      className={
                        "h-7 rounded-[4px] border border-transparent bg-field px-2 text-[13px] hover:border-line focus:outline-none " +
                        (binding ? "text-fg" : "text-fg-dim")
                      }
                    >
                      <option value="">Keep saved value</option>
                      <option value="field">Show in the panel</option>
                      {kind && (
                        <optgroup label="Drive with">
                          {WORKFLOW_PARAMS.filter((p) => p.kind === kind).map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    {binding?.target === "field" && (
                      <div className="col-start-3">
                        <TextInput
                          aria-label={`Panel label for ${input}`}
                          value={binding.label ?? ""}
                          placeholder={`Label (default: ${input})`}
                          onChange={(e) => setLabel(nodeId, input, e.target.value)}
                          className="h-7 text-[13px]"
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-6 py-3">
        <p className="text-[13px] text-fg-faint">
          {controlled} driven by the panel, {fields} shown as {fields === 1 ? "a field" : "fields"}
        </p>
        <div className="ml-auto flex items-center gap-2">
          {confirmDelete ? (
            <>
              <Button
                variant="danger"
                onClick={async () => {
                  await deleteWorkflow(workflow.id);
                  notify(`${workflow.name} removed`);
                  onClose();
                }}
              >
                Remove workflow
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              Remove
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save inputs
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
