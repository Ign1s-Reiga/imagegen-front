"use client";

import { Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { getSecret } from "@/lib/secrets";
import { midSentence } from "@/lib/text";
import { describeCredit } from "@/providers/credit";
import { SERVICE_ORDER, isImageKind, service } from "@/providers/registry";
import type { Connection, ConnectionConfig, ConnectionKind, CreditInfo } from "@/providers/types";
import { assistantFor, useApp } from "@/store/app";
import { hostKeyProblem } from "@/training/api";

import { Button, Field, TextArea, TextInput, cx, useFieldId } from "../ui";

type TestState = { status: "idle" } | { status: "running" } | { status: "ok" | "error"; message: string };

type CreditCheck =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; info: CreditInfo | null }
  | { status: "error"; message: string };

const describeError = (err: unknown) =>
  err instanceof DOMException && err.name === "TimeoutError"
    ? "No answer within 20 seconds."
    : err instanceof Error
      ? err.message
      : String(err);

function CreditSummary({ check, kind }: { check: CreditCheck; kind: ConnectionKind }) {
  if (check.status === "idle") return <p className="text-[13px] text-fg-faint">Not checked yet.</p>;
  if (check.status === "loading") return <p className="text-[13px] text-fg-faint">Checking</p>;
  if (check.status === "error") return <p className="max-h-32 overflow-y-auto break-words text-[13px] leading-snug text-danger">{check.message}</p>;
  if (!check.info) {
    return (
      <p className="text-[13px] text-fg-faint">
        {kind === "openai" ? "Add an admin key to see this month's spending." : "Add the API key to see the balance."}
      </p>
    );
  }
  const { headline, details } = describeCredit(check.info);
  return (
    <div>
      <p className={cx("text-[15px]", check.info.low ? "text-danger" : "text-fg")}>{headline}</p>
      {details.map((line) => (
        <p key={line} className="text-[13px] text-fg-dim">
          {line}
        </p>
      ))}
    </div>
  );
}

function uniqueName(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`;
}

function newConnection(kind: ConnectionKind, taken: string[]): Connection {
  const def = service(kind);
  const config: ConnectionConfig = {};
  for (const field of def.fields) if (field.type !== "secret" && field.default) config[field.key] = field.default;
  return { id: crypto.randomUUID(), kind, name: uniqueName(def.label, taken), config };
}

function ProviderPicker({ onPick, onCancel, canCancel }: { onPick: (kind: ConnectionKind) => void; onCancel: () => void; canCancel: boolean }) {
  return (
    <div className="max-w-xl">
      <h2 className="text-[17px] font-semibold">Add a connection</h2>
      <p className="mt-1 text-fg-dim">
        Choose where images are generated. You can add several and switch between them. Claude and OpenRouter also run the
        prompt helper and the pixel assistant. A GPU host is for LoRA training.
      </p>
      <ul className="mt-5 divide-y divide-line border-y border-line">
        {SERVICE_ORDER.map((kind) => {
          const def = service(kind);
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
  const def = service(initial.kind);
  const [name, setName] = useState(initial.name);
  const [config, setConfig] = useState<ConnectionConfig>(initial.config);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [hostKey, setHostKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [credit, setCredit] = useState<CreditCheck>({ status: "idle" });
  const nameId = useFieldId("name");

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    void Promise.all(
      def.fields
        .filter((f) => f.type === "secret")
        .map(async (f) => [f.key, (await getSecret(initial.id, f.key).catch(() => null)) ?? ""] as const),
    ).then(async (entries) => {
      if (cancelled) return;
      const saved = Object.fromEntries(entries.filter(([, v]) => v));
      setStored(saved);
      // Show the saved connection's credit right away.
      if (!def.getCredit) return;
      setCredit({ status: "loading" });
      try {
        const info = await def.getCredit({ ...initial.config, ...saved }, AbortSignal.timeout(20000));
        if (!cancelled) setCredit({ status: "done", info });
      } catch (err) {
        if (!cancelled) setCredit({ status: "error", message: describeError(err) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [def, initial.id, initial.config, isNew]);

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

  /** Reads credit with the values in the form, saved or not. */
  const checkCredit = async () => {
    if (!def.getCredit) return;
    setCredit({ status: "loading" });
    try {
      setCredit({ status: "done", info: await def.getCredit(effectiveConfig(), AbortSignal.timeout(20000)) });
    } catch (err) {
      setCredit({ status: "error", message: describeError(err) });
    }
  };

  const runTest = async () => {
    setTest({ status: "running" });
    setHostKey(null);
    try {
      const message = await def.testConnection(effectiveConfig(), AbortSignal.timeout(20000));
      setTest({ status: "ok", message });
      void checkCredit();
    } catch (err) {
      setTest({ status: "error", message: describeError(err) });
      // An SSH host seen for the first time: offer to trust its key once the
      // user has compared the fingerprint. A changed key is never offered.
      const problem = hostKeyProblem(err instanceof Error && err.cause ? err.cause : err);
      if (problem?.kind === "unknown" && def.trustHostKey) setHostKey(problem.fingerprint);
    }
  };

  const trustKey = async () => {
    if (!hostKey || !def.trustHostKey) return;
    setTest({ status: "running" });
    try {
      await def.trustHostKey(effectiveConfig(), hostKey);
      setHostKey(null);
      await runTest();
    } catch (err) {
      setTest({ status: "error", message: describeError(err) });
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
        <Field
          label="Name"
          htmlFor={nameId}
          help={
            isImageKind(def.kind)
              ? "Shown in the backend menu."
              : def.kind === "gpuhost"
                ? "Shown in the Training page's host menu."
                : "Shown in the assistant's model menu."
          }
        >
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
                {field.multiline ? (
                  <TextArea
                    id={id}
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-[12px] [-webkit-text-security:disc]"
                    value={secrets[field.key] ?? ""}
                    placeholder={hasStored ? "Saved. Paste to replace it" : field.placeholder}
                    onChange={(e) => setSecrets({ ...secrets, [field.key]: e.target.value })}
                  />
                ) : (
                  <TextInput
                    id={id}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={secrets[field.key] ?? ""}
                    placeholder={hasStored ? "Saved. Type to replace it" : field.placeholder}
                    onChange={(e) => setSecrets({ ...secrets, [field.key]: e.target.value })}
                  />
                )}
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
            "mt-5 max-h-40 overflow-y-auto break-words rounded-[4px] px-3 py-2 text-[13px] leading-snug",
            test.status === "ok" && "bg-ok/10 text-ok",
            test.status === "error" && "bg-danger/10 text-danger",
            test.status === "running" && "bg-field text-fg-dim",
          )}
        >
          {test.status === "running" ? "Testing connection" : test.message}
        </p>
      )}

      {hostKey && (
        <div className="mt-3 rounded-[4px] border border-line px-3 py-2 text-[13px] leading-snug">
          <p className="text-fg-dim">
            Before trusting this host, check that its key fingerprint is <code className="break-all text-fg">{hostKey}</code>. On the
            host, <code className="text-fg">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> prints it.
          </p>
          <Button size="sm" className="mt-2" onClick={() => void trustKey()}>
            Trust this host key
          </Button>
        </div>
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

      {def.getCredit && (
        <section aria-label="Credit" className="mt-8 flex items-start justify-between gap-4 border-t border-line pt-4">
          <div className="min-w-0">
            <h3 className="mb-1 text-[13px] font-medium text-fg-dim">
              {def.kind === "openai" ? "Spending this month" : "Credit"}
            </h3>
            <CreditSummary check={credit} kind={def.kind} />
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 whitespace-nowrap"
            onClick={() => void checkCredit()}
            disabled={credit.status === "loading"}
          >
            Check credit
          </Button>
        </section>
      )}
    </form>
  );
}

export function ConnectionsView() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const assistantId = useApp((s) => assistantFor(s)?.connection.id ?? null);
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
                <span className="text-[12.5px] text-fg-faint">
                  {service(c.kind).label}
                  {c.id === assistantId && ", runs the assistant"}
                </span>
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
