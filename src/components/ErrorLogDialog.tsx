"use client";

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useApp } from "@/store/app";

import { Button, Dialog, IconButton } from "./ui";

/**
 * An error shown whole in a large window, for messages too long to read in
 * the place they were reported (a server's validation output, a stack of
 * node errors). The text wraps and keeps its line breaks, and can be copied.
 */
export function ErrorLogDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const notify = useApp((s) => s.notify);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    // The webview can refuse the clipboard, or not have the API at all (which
    // throws before any promise); say so rather than leave the user to paste
    // whatever was there before.
    try {
      if (!navigator.clipboard) throw new Error("the clipboard is not available here");
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      setCopied(false);
      notify(`Could not copy the error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Dialog label={title} onClose={onClose} initialFocus={closeRef} className="flex max-h-full w-[min(960px,100%)] flex-col">
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <h2 className="flex-1 text-[15px] font-medium text-fg">{title}</h2>
        <IconButton label="Close" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <pre className="min-h-24 flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-[13px] leading-relaxed text-danger select-text">
        {text}
      </pre>
      <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
        <Button onClick={() => void copy()}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button ref={closeRef} onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
