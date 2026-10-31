"use client";

import { SquarePen, Wrench } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { useAgent, type AgentEntry } from "@/pixel/agent";
import { chatService } from "@/providers/registry";
import { useApp, useAssistant, type Assistant } from "@/store/app";

import { Button, IconButton, TextArea, cx, useFieldId } from "../ui";

const EXAMPLES = [
  "Draw a 16×16 green slime with a dark outline and a highlight",
  "Add a two-frame idle animation where it squashes down",
  "Recolour it in shades of blue",
];

function ModelPicker({ assistant }: { assistant: Assistant }) {
  const connections = useApp((s) => s.connections);
  const chatConnections = useMemo(() => connections.filter((c) => chatService(c)), [connections]);
  const models = useApp((s) => s.chatModels[assistant.connection.id]);
  const loadChatModels = useApp((s) => s.loadChatModels);
  const setAssistant = useApp((s) => s.setAssistant);
  const running = useAgent((s) => s.running);
  const empty = useAgent((s) => s.entries.length === 0);
  const reset = useAgent((s) => s.reset);
  const listId = useFieldId("assistant-models");

  useEffect(() => {
    void loadChatModels(assistant.connection.id);
  }, [assistant.connection.id, loadChatModels]);

  const choose = (model: string) => setAssistant({ connectionId: assistant.connection.id, model: model.trim() });

  return (
    <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
      {chatConnections.length > 1 && (
        <select
          aria-label="Assistant connection"
          value={assistant.connection.id}
          onChange={(e) => setAssistant({ connectionId: e.target.value, model: "" })}
          disabled={running}
          className="h-7 w-28 shrink-0 rounded-[4px] border border-transparent bg-field px-1.5 text-[13px] text-fg hover:border-line focus:border-safelight/70 focus:outline-none disabled:opacity-60"
        >
          {chatConnections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <input
        // Remounts when the choice changes elsewhere, so typing is never overwritten.
        key={`${assistant.connection.id}:${assistant.model}`}
        list={listId}
        aria-label="Assistant model"
        title={models?.error ? `Could not list models: ${models.error}` : `Model for the assistant and the prompt helper (${assistant.connection.name})`}
        defaultValue={assistant.model}
        spellCheck={false}
        disabled={running}
        onChange={(e) => {
          // A pick from the list applies at once; typed text applies when leaving the field.
          if (models?.models?.some((m) => m.id === e.target.value)) choose(e.target.value);
        }}
        onBlur={(e) => {
          if (e.target.value.trim() !== assistant.model) choose(e.target.value);
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="h-7 min-w-0 flex-1 rounded-[4px] border border-transparent bg-field px-2 text-[13px] text-fg hover:border-line focus:border-safelight/70 focus:outline-none disabled:opacity-60"
      />
      <datalist id={listId}>
        {models?.models?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </datalist>
      <IconButton label="New chat" onClick={reset} disabled={running || empty}>
        <SquarePen size={14} />
      </IconButton>
    </div>
  );
}

function Entry({ entry }: { entry: AgentEntry }) {
  switch (entry.kind) {
    case "user":
      return <p className="ml-8 whitespace-pre-wrap rounded-[6px] bg-field px-3 py-2 text-[14px] leading-snug text-fg">{entry.text}</p>;
    case "assistant":
      return entry.text ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-fg">{entry.text}</p> : null;
    case "tool":
      return (
        <p className={cx("flex items-start gap-1.5 text-[12.5px] leading-snug", entry.error ? "text-danger/90" : "text-fg-faint")}>
          <Wrench size={12} className="mt-[3px] shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{entry.text}</span>
        </p>
      );
    case "error":
      return (
        <p role="alert" className="rounded-[4px] bg-danger/10 px-3 py-2 text-[13px] leading-snug text-danger">
          {entry.text}
        </p>
      );
    case "note":
      return <p className="text-[12.5px] text-fg-faint">{entry.text}</p>;
  }
}

export function AgentPanel() {
  const assistant = useAssistant();
  const entries = useAgent((s) => s.entries);
  const running = useAgent((s) => s.running);
  const send = useAgent((s) => s.send);
  const stop = useAgent((s) => s.stop);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useFieldId("assistant-message");

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries, running]);

  if (!assistant) {
    return (
      <div className="flex flex-1 flex-col justify-center gap-3 px-6">
        <p className="text-fg">No assistant connected yet.</p>
        <p className="text-fg-dim">The assistant draws and edits the sprite for you from a chat. It needs a Claude or OpenRouter connection.</p>
        <Link
          href="/connections"
          className="inline-flex h-8 items-center self-start rounded-[4px] bg-safelight px-3 font-semibold text-safelight-ink hover:bg-safelight-strong"
        >
          Add a connection
        </Link>
      </div>
    );
  }

  const submit = (e?: Pick<FormEvent, "preventDefault">) => {
    e?.preventDefault();
    if (running || !draft.trim()) return;
    void send(draft);
    setDraft("");
  };

  const last = entries[entries.length - 1];
  const thinking = last?.kind === "assistant" && !last.done && !last.text;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModelPicker assistant={assistant} />

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
        {entries.length === 0 ? (
          <div className="space-y-3">
            <p className="text-[13.5px] leading-snug text-fg-dim">
              Ask for a sprite or a change and the assistant draws it on the canvas. Everything it changes for one message is
              one undo step.
            </p>
            <ul className="space-y-1.5">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(example);
                      inputRef.current?.focus();
                    }}
                    className="w-full rounded-[4px] border border-line px-2.5 py-1.5 text-left text-[13px] leading-snug text-fg-dim hover:border-line-strong hover:text-fg"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          entries.map((entry) => <Entry key={entry.id} entry={entry} />)
        )}
        {running && (
          <p className="text-[12.5px] text-safelight" role="status">
            {thinking ? "Thinking" : "Working"}
          </p>
        )}
      </div>

      <form onSubmit={submit} className="border-t border-line p-3">
        <label htmlFor={inputId} className="sr-only">
          Message to the assistant
        </label>
        <TextArea
          id={inputId}
          ref={inputRef}
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
          placeholder="Describe a sprite or a change"
          className="text-[14px] leading-snug"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[12px] text-fg-faint">Enter sends, Shift Enter adds a line</span>
          {running ? (
            <Button size="sm" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" type="submit" disabled={!draft.trim()}>
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
