import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { exportImage, galleryDir, readImageBytes, type ImageRecord } from "./gallery";

/** The clipboard only takes PNG, so other formats are re-encoded first. */
export async function copyImage(image: ImageRecord) {
  const bytes = await readImageBytes(image.id);
  let blob = new Blob([bytes], { type: image.mime });
  if (image.mime !== "image/png") {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    blob = await canvas.convertToBlob({ type: "image/png" });
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

/** Returns false when the user closed the dialog. */
export async function saveImageAs(image: ImageRecord, suggestedName: string): Promise<boolean> {
  return (await exportImage(image.id, suggestedName)) !== null;
}

export const revealImage = (image: ImageRecord) => revealItemInDir(image.path);

export async function openGalleryFolder() {
  await openPath(await galleryDir());
}

/** A short file name from the prompt, e.g. "lighthouse-at-dusk-3f2a". */
export function suggestedFileName(prompt: string, id: string) {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return `${words || "image"}-${id.slice(0, 4)}`;
}
