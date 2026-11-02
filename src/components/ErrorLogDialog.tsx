"use client";

import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, Dialog, IconButton } from "./ui";

/**
 * An error shown whole in a large window, for messages too long to read in
 * the place they were reported (a server's validation output, a stack of
 * node errors). The text wraps and keeps its line breaks, and can be copied.
 */
export function ErrorLogDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Dialog label={title} onClose={onClose} className="flex max-h-full w-[min(960px,100%)] flex-col">
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
        <Button onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}
