"use client";

import { Paperclip, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { useImageUrl } from "@/lib/use-image-url";
import type { InputImage } from "@/providers/types";
import { useApp } from "@/store/app";

import { IconButton, cx } from "../ui";

function Thumb({
  image,
  index,
  slot,
  onRemove,
}: {
  image: InputImage;
  index: number;
  /** The workflow input this image goes to, when a workflow names it. */
  slot?: string;
  onRemove: () => void;
}) {
  const url = useImageUrl(image.bytes, image.mime) ?? undefined;
  return (
    <li
      className="group relative size-14 shrink-0"
      title={`${slot ? `${slot}: ` : ""}${image.name}, ${image.width} × ${image.height}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={`Reference ${index + 1}: ${image.name}`} className="size-full rounded-[3px] bg-surround object-cover" />
      {/* Numbers make "the second image" in the prompt easy to match. */}
      <span aria-hidden className="absolute bottom-0.5 left-0.5 rounded-[2px] bg-panel/85 px-1 text-[11px] leading-4 text-fg-dim">
        {index + 1}
      </span>
      <button
        type="button"
        aria-label={`Remove reference ${index + 1}`}
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-raised text-fg-dim opacity-0 ring-1 ring-line-strong transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100"
      >
        <X size={12} />
      </button>
    </li>
  );
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

/**
 * The prompt with images attached to it, like a chat message: paste, drop or
 * attach them, and they go to the model as references in this order.
 */
export function PromptBox({
  id,
  value,
  onChange,
  references,
  limit,
  backend,
  slots,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  references: InputImage[];
  /** How many references the backend takes; 0 when it cannot use them. */
  limit: number;
  backend: string;
  /**
   * What each numbered attachment is for, from an imported workflow's
   * Reference inputs: the first entry names where image 1 goes. Every one is
   * needed; an empty entry is a number the workflow has no input for.
   */
  slots?: string[];
}) {
  const addReferences = useApp((s) => s.addReferences);
  const removeReference = useApp((s) => s.removeReference);
  const notify = useApp((s) => s.notify);
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (files: File[]) => {
    if (!files.length) return;
    if (!limit) {
      notify(
        slots
          ? "This workflow has no Reference inputs. Title a LoadImage node \"Reference 1\" and import it again, or map one in the workflow inputs."
          : `${backend} cannot use reference images. OpenAI, OpenRouter, fal.ai and Replicate can.`,
      );
      return;
    }
    void addReferences(files);
  };

  const count = references.length;
  const warning =
    count > limit
      ? limit
        ? `${backend} takes at most ${limit} reference images; remove ${count - limit}.`
        : `${backend} cannot use reference images; remove them or switch backends.`
      : null;
  // A workflow names what each image is for, and needs all of them.
  const needed = slots?.map((title, i) => ({ number: i + 1, title })).filter((s) => s.title && s.number > count) ?? [];
  const hint =
    warning ??
    (needed.length
      ? `Attach ${needed.map((s) => `${s.number}: ${s.title}`).join(", ")}`
      : count
        ? `${count} reference image${count === 1 ? "" : "s"}, sent in this order`
        : limit
          ? "Paste, drop or attach images for the model to follow"
          : "");

  return (
    <div
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        take(Array.from(e.dataTransfer.files));
      }}
      className={cx(
        "rounded-[4px] border transition-colors",
        over ? "border-safelight bg-safelight/5" : "border-transparent bg-field hover:border-line focus-within:border-safelight",
      )}
    >
      {count > 0 && (
        <ul aria-label="Reference images" className="flex flex-wrap gap-2 px-2.5 pt-2.5">
          {references.map((image, i) => (
            <Thumb
              key={`${i}-${image.name}-${image.bytes.length}`}
              image={image}
              index={i}
              slot={slots?.[i] || undefined}
              onRemove={() => removeReference(i)}
            />
          ))}
        </ul>
      )}
      <textarea
        id={id}
        rows={count ? 5 : 7}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          // Pasted images are attached; pasted text is typed as usual.
          const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
          if (!files.length) return;
          e.preventDefault();
          take(files);
        }}
        placeholder="Describe the image"
        className="block w-full resize-none bg-transparent px-2.5 py-2 font-serif text-[16.5px] leading-[1.5] text-fg placeholder:text-fg-faint"
        // The whole box shows focus, so the app-wide focus outline would draw a second ring here.
        style={{ outline: "none" }}
      />
      {(hint || limit > 0) && (
        <div className="flex items-center gap-2 pb-1 pl-2.5 pr-1">
          <p className={cx("min-w-0 flex-1 text-[12px] leading-snug", warning ? "text-danger" : "text-fg-faint")}>{hint}</p>
          {limit > 0 && (
            <IconButton label="Attach reference images" onClick={() => fileRef.current?.click()} disabled={count >= limit}>
              <Paperclip size={15} />
            </IconButton>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            aria-label="Reference image files"
            onChange={(e) => {
              take(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}
