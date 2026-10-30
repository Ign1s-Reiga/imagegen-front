"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { getSecret } from "@/lib/secrets";
import { midSentence } from "@/lib/text";
import { PROVIDER_ORDER, provider } from "@/providers/registry";
import type { Connection, ConnectionConfig, ProviderKind } from "@/providers/types";
import { useApp } from "@/store/app";

import { Button, Field, TextInput, cx, useFieldId } from "../ui";

type TestState = { status: "idle" } | { status: "running" } | { status: "ok" | "error"; message: string };

function uniqueName(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

function newConnection(kind: ProviderKind, taken: string[]): Connection {
  const def = provider(kind);
  const config: ConnectionConfig = {};
  for (const field of def.fields) if (field.type !== "secret" && field.default) config[field.key] = field.default;
  return { id: crypto.randomUUID(), kind, name: uniqueName(def.label, taken), config };
}

function ProviderPicker({ onPick, onCancel, canCancel }: { onPick: (kind: ProviderKind) => void; onCancel: () => void; canCancel: boolean }) {
  return (
    <div className="max-w-xl">
      <h2 className="text-[17px] font-semibold">Add a connection</h2>
      <p className="mt-1 text-fg-dim">Choose where images are generated. You can add several and switch between them.</p>
      <ul className="mt-5 divide-y divide-line border-y border-line">
        {PROVIDER_ORDER.map((kind) => {
          const def = provider(kind);
          return (
            <li key={kind}>
              <button
                type="button"
                onClick={() => onPick(kind)}
                className="flex w-full items-baseline gap-4 px-2 py-3 text-left hover:bg-field"
              >
                <span className="w-48 shrink-0 font-medium text-fg">{def.label}</span>
                <span className="text-[13.5px] text-fg-dim">{def.summary}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {canCancel && (
        <Button variant="ghost" className="mt-4" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

function ConnectionEditor({ initial, isNew, onDone }: { initial: Connection; isNew: boolean; onDone: (id: string | null) => void }) {
  const saveConnection = useApp((s) => s.saveConnection);
  const removeConnection = useApp((s) => s.removeConnection);
  const notify = useApp((s) => s.notify);
  const def = provider(initial.kind);
  const [name, setName] = useState(initial.name);
  const [config, setConfig] = useState<ConnectionConfig>(initial.config);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameId = useFieldId("name");

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    void Promise.all(
      def.fields
        .filter((f) => f.type === "secret")
        .map(async (f) => [f.key, (await getSecret(initial.id, f.key).catch(() => null)) ?? ""] as const),
    ).then((entries) => !cancelled && setStored(Object.fromEntries(entries.filter(([, v]) => v))));
    return () => {
      cancelled = true;
    };
  }, [def, initial.id, isNew]);

  const effectiveConfig = (): ConnectionConfig => {
    const merged: ConnectionConfig = { ...config };
    for (const field of def.fields) {
      if (field.type !== "secret") continue;
      const value = secrets[field.key] || (removed.has(field.key) ? "" : stored[field.key]);
      if (value) merged[field.key] = value;
    }
    return merged;
  };

  const missing = def.fields.filter((f) => f.required && !effectiveConfig()[f.key]?.trim());

  const runTest = async () => {
    setTest({ status: "running" });
    try {
      const message = await def.testConnection(effectiveConfig(), AbortSignal.timeout(20000));
      setTest({ status: "ok", message });
    } catch (err) {
      const message = err instanceof DOMException && err.name === "TimeoutError" ? "No answer within 20 seconds." : err instanceof Error ? err.message : String(err);
      setTest({ status: "error", message });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const secretChanges: Record<string, string | null> = {};
      for (const field of def.fields.filter((f) => f.type === "secret")) {
        if (secrets[field.key]) secretChanges[field.key] = secrets[field.key];
        else if (removed.has(field.key)) secretChanges[field.key] = null;
      }
      const cleanConfig = Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, v.trim()]));
      await saveConnection({ ...initial, name: name.trim() || def.label, config: cleanConfig }, secretChanges);
      notify(isNew ? `${name} added` : "Changes saved");
      onDone(initial.id);
    } catch (err) {
      notify(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="max-w-xl"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-[17px] font-semibold">{isNew ? `New ${def.label} connection` : name || def.label}</h2>
      <p className="mt-1 text-fg-dim">{def.summary}</p>

      <div className="mt-6 space-y-4">
        <Field label="Name" htmlFor={nameId} help="Shown in the backend menu.">
          <TextInput id={nameId} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        {def.fields.map((field) => {
          const id = `${initial.id}-${field.key}`;
          if (field.type === "secret") {
            const hasStored = Boolean(stored[field.key]) && !removed.has(field.key);
            return (
              <Field
                key={field.key}
                label={field.required ? field.label : `${field.label} (optional)`}
                htmlFor={id}
                help={field.help ?? "Stored in your system keychain, not in the settings file."}
                aside={
                  hasStored && (
                    <button
                      type="button"
                      className="text-[12.5px] text-fg-dim hover:text-danger"
                      onClick={() => setRemoved(new Set(removed).add(field.key))}
                    >
                      Remove saved {midSentence(field.label)}
                    </button>
                  )
                }
              >
                <TextInput
                  id={id}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={secrets[field.key] ?? ""}
                  placeholder={hasStored ? "Saved. Type to replace it" : field.placeholder}
                  onChange={(e) => setSecrets({ ...secrets, [field.key]: e.target.value })}
                />
              </Field>
            );
          }
          return (
            <Field
              key={field.key}
              label={field.required ? field.label : `${field.label} (optional)`}
              htmlFor={id}
              help={field.help}
            >
              <TextInput
                id={id}
                type={field.type === "url" ? "url" : "text"}
                spellCheck={false}
                value={config[field.key] ?? ""}
                placeholder={field.placeholder}
                onChange={(e) => setConfig({ ...config, [field.key]: e.target.value })}
              />
            </Field>
          );
        })}
      </div>

      {test.status !== "idle" && (
        <p
          role="status"
          className={cx(
            "mt-5 rounded-[4px] px-3 py-2 text-[13px] leading-snug",
            test.status === "ok" && "bg-ok/10 text-ok",
            test.status === "error" && "bg-danger/10 text-danger",
            test.status === "running" && "bg-field text-fg-dim",
          )}
        >
          {test.status === "running" ? "Testing connection" : test.message}
        </p>
      )}

      <div className="mt-6 flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={saving || missing.length > 0}>
          {isNew ? "Add connection" : "Save changes"}
        </Button>
        <Button onClick={() => void runTest()} disabled={test.status === "running"}>
          Test connection
        </Button>
        {isNew ? (
          <Button variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
        ) : confirmDelete ? (
          <span className="ml-auto flex items-center gap-1">
            <Button
              variant="danger"
              onClick={async () => {
                await removeConnection(initial.id);
                notify(`${name} removed`);
                onDone(null);
              }}
            >
              Remove {name}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="ghost" className="ml-auto" onClick={() => setConfirmDelete(true)}>
            Remove connection
          </Button>
        )}
      </div>
      {missing.length > 0 && (
        <p className="mt-3 text-[13px] text-fg-faint">
          Fill in {missing.map((f) => midSentence(f.label)).join(" and ")} to save.
        </p>
      )}
    </form>
  );
}

export function ConnectionsView() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const [selectedId, setSelectedId] = useState<string | null>(activeConnectionId ?? connections[0]?.id ?? null);
  const [adding, setAdding] = useState<Connection | null>(null);
  const [picking, setPicking] = useState(connections.length === 0);

  const selected = connections.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex h-full">
      <nav aria-label="Connections" className="flex w-72 shrink-0 flex-col border-r border-line bg-panel">
        <ul className="flex-1 overflow-y-auto py-2">
          {connections.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(c.id);
                  setAdding(null);
                  setPicking(false);
                }}
                aria-current={selectedId === c.id && !adding && !picking}
                className={cx(
                  "flex w-full flex-col px-4 py-2 text-left",
                  selectedId === c.id && !adding && !picking ? "bg-raised" : "hover:bg-field",
                )}
              >
                <span className="flex items-center gap-2 text-fg">
                  {c.name}
                  {c.id === activeConnectionId && <span className="size-1.5 rounded-full bg-safelight" aria-label="In use" />}
                </span>
                <span className="text-[12.5px] text-fg-faint">{provider(c.kind).label}</span>
              </button>
            </li>
          ))}
          {connections.length === 0 && <li className="px-4 py-2 text-[13px] text-fg-faint">No connections yet.</li>}
        </ul>
        <div className="border-t border-line p-3">
          <Button
            className="w-full"
            onClick={() => {
              setAdding(null);
              setPicking(true);
            }}
          >
            <Plus size={15} />
            Add connection
          </Button>
        </div>
      </nav>

      <section className="flex-1 overflow-y-auto px-10 py-8">
        {picking ? (
          <ProviderPicker
            canCancel={connections.length > 0}
            onCancel={() => setPicking(false)}
            onPick={(kind) => {
              setPicking(false);
              setAdding(newConnection(kind, connections.map((c) => c.name)));
            }}
          />
        ) : adding ? (
          <ConnectionEditor
            key={adding.id}
            initial={adding}
            isNew
            onDone={(id) => {
              setAdding(null);
              if (id) setSelectedId(id);
              else if (!connections.length) setPicking(true);
            }}
          />
        ) : selected ? (
          <ConnectionEditor
            key={selected.id}
            initial={selected}
            isNew={false}
            onDone={(id) => setSelectedId(id ?? connections.find((c) => c.id !== selected.id)?.id ?? null)}
          />
        ) : (
          <p className="text-fg-dim">Select a connection or add one.</p>
        )}
      </section>
    </div>
  );
}
