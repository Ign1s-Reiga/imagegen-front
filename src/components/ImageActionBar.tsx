"use client";

import { Copy, Download, FolderOpen, ImageUp, Paperclip, RotateCcw, Star, Trash2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import type { GenerationRecord, ImageRecord } from "@/lib/gallery";
import { copyImage, revealImage, saveImageAs, suggestedFileName } from "@/lib/image-actions";
import { useApp } from "@/store/app";

import { IconButton } from "./ui";

export function ImageActionBar({
  generation,
  image,
  onDeleted,
}: {
  generation: GenerationRecord;
  image: ImageRecord;
  onDeleted?: () => void;
}) {
  const notify = useApp((s) => s.notify);
  const toggleFavorite = useApp((s) => s.toggleFavorite);
  const reuseSettings = useApp((s) => s.reuseSettings);
  const loadAsInput = useApp((s) => s.loadAsInput);
  const loadAsReference = useApp((s) => s.loadAsReference);
  const removeImage = useApp((s) => s.removeImage);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const favorite = image.favorite;
  const router = useRouter();
  const pathname = usePathname();
  const toGenerate = () => {
    if (pathname !== "/") router.push("/");
  };

  const run = (action: () => Promise<unknown>, done?: string) => async () => {
    try {
      await action();
      if (done) notify(done);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        label={favorite ? "Remove from favorites" : "Add to favorites"}
        active={favorite}
        onClick={run(() => toggleFavorite(image))}
      >
        <Star size={15} fill={favorite ? "currentColor" : "none"} />
      </IconButton>
      <IconButton label="Copy image" onClick={run(() => copyImage(image), "Image copied")}>
        <Copy size={15} />
      </IconButton>
      <IconButton
        label="Save a copy"
        onClick={run(async () => {
          if (await saveImageAs(image, suggestedFileName(generation.prompt, image.id))) notify("Image saved");
        })}
      >
        <Download size={15} />
      </IconButton>
      <IconButton label="Show in folder" onClick={run(() => revealImage(image))}>
        <FolderOpen size={15} />
      </IconButton>
      <IconButton label="Use as input image" onClick={run(async () => {
          await loadAsInput(image);
          toGenerate();
        }, "Image set as input")}>
        <ImageUp size={15} />
      </IconButton>
      <IconButton
        label="Attach to the prompt as a reference"
        onClick={run(async () => {
          await loadAsReference(image);
          toGenerate();
        }, "Image attached to the prompt")}
      >
        <Paperclip size={15} />
      </IconButton>
      <IconButton
        label="Reuse these settings"
        onClick={() => {
          reuseSettings(generation);
          toGenerate();
        }}
      >
        <RotateCcw size={15} />
      </IconButton>
      {confirmDelete ? (
        <span className="ml-1 flex items-center gap-1 text-[13px]">
          <button
            type="button"
            className="rounded-[4px] px-2 py-1 text-danger hover:bg-danger/12"
            onClick={run(async () => {
              await removeImage(image);
              setConfirmDelete(false);
              onDeleted?.();
            }, "Image deleted")}
          >
            Delete image
          </button>
          <button type="button" className="px-1 text-fg-dim hover:text-fg" onClick={() => setConfirmDelete(false)}>
            Keep
          </button>
        </span>
      ) : (
        <IconButton label="Delete image" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={15} />
        </IconButton>
      )}
    </div>
  );
}
