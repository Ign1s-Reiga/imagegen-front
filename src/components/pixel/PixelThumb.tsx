"use client";

import { useEffect, useRef } from "react";

import { pixelsToImageData } from "@/pixel/image-io";

import { cx } from "../ui";

/** Checkerboard behind transparent pixels, in the chrome's neutral greys. */
export const CHECKER_STYLE = {
  backgroundColor: "#2c2c2c",
  backgroundImage:
    "linear-gradient(45deg, #363636 25%, transparent 25%, transparent 75%, #363636 75%), linear-gradient(45deg, #363636 25%, transparent 25%, transparent 75%, #363636 75%)",
  backgroundSize: "8px 8px",
  backgroundPosition: "0 0, 4px 4px",
} as const;

/** Pixels drawn at their own size and scaled up by CSS without smoothing. */
export function PixelThumb({
  pixels,
  width,
  height,
  className,
  label,
}: {
  pixels: Uint32Array;
  width: number;
  height: number;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx) ctx.putImageData(pixelsToImageData(pixels, width, height), 0, 0);
  }, [pixels, width, height]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("block object-contain", className)}
      style={{ ...CHECKER_STYLE, imageRendering: "pixelated" }}
    />
  );
}
