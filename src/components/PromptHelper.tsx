"use client";

import { Undo2, WandSparkles, X } from "lucide-react";
import { useState } from "react";

import { improvePrompt, type ImprovedPrompt, type PromptTarget } from "@/assistant/prompt-helper";
import { isAbortError } from "@/lib/http";
import { useApp, useAssistant } from "@/store/app";

const BUTTON =
  "inline-flex h-6 items-center gap-1 rounded-[3px] px-1.5 text-[12.5px] text-fg-dim hover:bg-raised hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

/** "Improve" for a prompt field: the assistant model rewrites the prompt for the target model. */
export function PromptHelper({
  prompt,
  negativePrompt,
  target,
  onChange,
}: {
  prompt: string;
  negativePrompt?: string;
  target: PromptTarget;
  onChange: (next: ImprovedPrompt) => void;
}) {
  const assistant = useAssistant();
  const notify = useApp((s) => s.notify);
  const [running, setRunning] = useState<AbortController | null>(null);
  const [undo, setUndo] = useState<{ before: ImprovedPrompt; after: string } | null>(null);

  const run = async () => {
    if (!assistant || !prompt.trim()) return;
    const controller = new AbortController();
    setRunning(controller);
    try {
      const next = await improvePrompt(assistant, { prompt, negativePrompt }, target, controller.signal);
      setUndo({ before: { prompt, negativePrompt }, after: next.prompt });
      onChange(next);
    } catch (err) {
      if (!controller.signal.aborted && !isAbortError(err)) {
        notify(`Could not improve the prompt: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setRunning(null);
    }
  };

  if (running) {
    return (
      <span className="flex items-center gap-1 text-[12.5px] text-safelight" role="status">
        Improving
        <button type="button" aria-label="Stop improving the prompt" title="Stop" onClick={() => running.abort()} className={BUTTON}>
          <X size={13} />
        </button>
      </span>
    );
  }

  // Undo is offered until the prompt is edited again.
  const canUndo = undo !== null && undo.after === prompt;
  const title = !assistant
    ? "Add a Claude or OpenRouter connection to rewrite prompts"
    : !prompt.trim()
      ? "Write a prompt first"
      : `Rewrite the prompt for this model with ${assistant.model}`;

  return (
    <span className="flex items-center gap-0.5">
      {canUndo && (
        <button
          type="button"
          className={BUTTON}
          onClick={() => {
            onChange(undo.before);
            setUndo(null);
          }}
          title="Put back the prompt you wrote"
        >
          <Undo2 size={13} />
          Undo
        </button>
      )}
      <button type="button" className={BUTTON} onClick={() => void run()} disabled={!assistant || !prompt.trim()} title={title}>
        <WandSparkles size={13} />
        Improve
      </button>
    </span>
  );
}
