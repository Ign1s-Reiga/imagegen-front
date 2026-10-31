"use client";

import { useMemo } from "react";

import { toDataUri, type Bytes } from "./bytes";

/**
 * A data URL for showing image bytes in an <img>. Unlike an object URL it needs
 * no freeing, so React's development double-mount (which runs effect cleanups
 * once) cannot leave the image pointing at a freed URL.
 */
export function useImageUrl(bytes: Bytes | null | undefined, mime: string): string | null {
  return useMemo(() => (bytes ? toDataUri(bytes, mime) : null), [bytes, mime]);
}
