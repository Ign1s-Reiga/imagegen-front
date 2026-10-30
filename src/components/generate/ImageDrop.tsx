"use client";

import { ImagePlus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { bytesToObjectUrl } from "@/lib/bytes";
import type { InputImage } from "@/providers/types";

import { cx } from "../ui";

export function ImageDrop({
  label,
  image,
  onFile,
  onClear,
  hint,
}: {
  label: string;
  image: InputImage | null;
  onFile: (file: File) => void;
  onClear: () => void;
  hint: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const url = useMemo(() => (image ? bytesToObjectUrl(image.bytes, image.mime) : null), [image]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const take = (files: FileList | null | undefined) => {
    const file = Array.from(files ?? []).find((f) => f.type.startsWith("image/"));
    if (file) onFile(file);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
      onPaste={(e) => take(e.clipboardData.files)}
      className={cx(
        "rounded-[5px] border border-dashed transition-colors",
        over ? "border-safelight bg-safelight/5" : "border-line-strong",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
      {image && url ? (
        <div className="flex items-center gap-3 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={label} className="size-16 shrink-0 rounded-[3px] bg-surround object-contain" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] text-fg">{image.name}</p>
            <p className="text-[12.5px] text-fg-faint">
              {image.width} × {image.height}
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-0.5 text-[12.5px] text-fg-dim hover:text-fg"
            >
              Replace
            </button>
          </div>
          <button
            type="button"
            aria-label={`Remove ${label.toLowerCase()}`}
            onClick={onClear}
            className="self-start rounded-[4px] p-1 text-fg-faint hover:bg-raised hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center gap-3 px-3 py-3 text-left text-fg-dim hover:text-fg"
        >
          <ImagePlus size={18} strokeWidth={1.5} className="shrink-0" />
          <span className="text-[13px] leading-snug">{hint}</span>
        </button>
      )}
    </div>
  );
}
