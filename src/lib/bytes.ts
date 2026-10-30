export type Bytes = Uint8Array<ArrayBuffer>;

export function bytesToBase64(bytes: Bytes): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Bytes {
  const binary = atob(base64.replace(/^data:[^,]*,/, "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toDataUri(bytes: Bytes, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export function parseDataUri(uri: string): { bytes: Bytes; mime: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(uri);
  if (!match) return null;
  const mime = match[1] ?? "application/octet-stream";
  const bytes = match[2]
    ? base64ToBytes(match[3])
    : new TextEncoder().encode(decodeURIComponent(match[3]));
  return { bytes: bytes as Bytes, mime };
}

/** Identifies an image from its magic bytes; falls back to the given hint. */
export function sniffImageMime(bytes: Bytes, hint?: string | null): string {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  const clean = hint?.split(";")[0].trim();
  return clean?.startsWith("image/") ? clean : "image/png";
}

export function extForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

export async function imageDimensions(
  bytes: Bytes,
  mime: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

export function bytesToObjectUrl(bytes: Bytes, mime: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
