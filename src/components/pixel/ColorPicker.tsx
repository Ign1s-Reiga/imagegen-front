"use client";

import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { hexToRgb, hsvToRgb, parseHex, rgbToHex, rgbToHsv, type Hsv } from "@/pixel/color";

import { cx } from "../ui";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const HUES = "linear-gradient(to right, #f00 0%, #ff0 16.667%, #0f0 33.333%, #0ff 50%, #00f 66.667%, #f0f 83.333%, #f00 100%)";

const FIELD =
  "h-7 w-full min-w-0 rounded-[4px] border border-transparent bg-field px-1.5 text-[13px] text-fg hover:border-line focus:border-safelight/70 focus:outline-none";

const THUMB = "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.55)]";

/** Pointer handlers that report the position inside the element as 0..1 while the left button is held. */
function drag(onPoint: (x: number, y: number) => void) {
  const point = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPoint(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
  };
  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      point(e);
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) point(e);
    },
  };
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/** Arrow keys as [dx, dy] with up positive; Shift moves ten times as far. */
function arrows(e: ReactKeyboardEvent): [number, number] | null {
  const d = ARROWS[e.key];
  if (!d) return null;
  e.preventDefault();
  const step = e.shiftKey ? 10 : 1;
  return [d[0] * step, d[1] * step];
}

/**
 * Picks an opaque colour as HSV (a saturation/value area and a hue strip) or
 * RGB. HSV is kept here between changes, so hue and saturation survive greys
 * and black, which have none of their own.
 */
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const hex = value.toLowerCase();
  const [hsv, setHsv] = useState(() => rgbToHsv(...hexToRgb(hex)));
  const [seen, setSeen] = useState(hex);
  if (hex !== seen) {
    // Changed from outside (swatch, eyedropper, swap, undo): follow it.
    setSeen(hex);
    if (rgbToHex(...hsvToRgb(hsv)) !== hex) setHsv(rgbToHsv(...hexToRgb(hex), hsv));
  }

  const update = (next: Hsv) => {
    setHsv(next);
    const nextHex = rgbToHex(...hsvToRgb(next));
    if (nextHex !== hex) onChange(nextHex);
  };
  const rgb = hsvToRgb(hsv);
  const setChannel = (i: number, n: number) => {
    const next = [...rgb] as [number, number, number];
    next[i] = n;
    update(rgbToHsv(...next, hsv));
  };
  const s = Math.round(hsv.s * 100);
  const v = Math.round(hsv.v * 100);

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Saturation and value"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={s}
        aria-valuetext={`Saturation ${s}%, value ${v}%`}
        className="relative h-24 cursor-crosshair touch-none rounded-[3px]"
        style={{
          backgroundColor: `hsl(${hsv.h} 100% 50%)`,
          backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
        }}
        {...drag((x, y) => update({ ...hsv, s: x, v: 1 - y }))}
        onKeyDown={(e) => {
          const d = arrows(e);
          if (d) update({ ...hsv, s: clamp(hsv.s + d[0] / 100, 0, 1), v: clamp(hsv.v + d[1] / 100, 0, 1) });
        }}
      >
        <span className={cx(THUMB, "size-3 rounded-full")} style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hex }} />
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`${Math.round(hsv.h)}°`}
        className="relative my-0.5 h-3 cursor-pointer touch-none rounded-[3px]"
        style={{ backgroundImage: HUES }}
        {...drag((x) => update({ ...hsv, h: x * 360 }))}
        onKeyDown={(e) => {
          const d = arrows(e);
          if (d) update({ ...hsv, h: clamp(hsv.h + d[0] + d[1], 0, 360) });
        }}
      >
        <span
          className={cx(THUMB, "top-1/2 h-[18px] w-[9px] rounded-[3px]")}
          style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        />
      </div>

      <div className="grid grid-cols-3 gap-x-2 gap-y-1.5">
        <Channel label="H" name="Hue, 0 to 360°" value={hsv.h} max={360} onChange={(h) => update({ ...hsv, h })} />
        <Channel label="S" name="Saturation, 0 to 100%" value={hsv.s * 100} max={100} onChange={(n) => update({ ...hsv, s: n / 100 })} />
        <Channel label="V" name="Value (brightness), 0 to 100%" value={hsv.v * 100} max={100} onChange={(n) => update({ ...hsv, v: n / 100 })} />
        <Channel label="R" name="Red, 0 to 255" value={rgb[0]} max={255} onChange={(n) => setChannel(0, n)} />
        <Channel label="G" name="Green, 0 to 255" value={rgb[1]} max={255} onChange={(n) => setChannel(1, n)} />
        <Channel label="B" name="Blue, 0 to 255" value={rgb[2]} max={255} onChange={(n) => setChannel(2, n)} />
      </div>
    </div>
  );
}

/** A whole-number field that applies while typing; arrow keys step by 1, or 10 with Shift. */
function Channel({ label, name, value, max, onChange }: { label: string; name: string; value: number; max: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = Math.round(value);
  const set = (n: number) => onChange(clamp(n, 0, max));
  return (
    <label className="flex min-w-0 items-center gap-1.5" title={name}>
      <span aria-hidden className="w-2.5 shrink-0 text-[12.5px] text-fg-faint">
        {label}
      </span>
      <input
        aria-label={name}
        inputMode="numeric"
        autoComplete="off"
        value={draft ?? String(shown)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          const text = e.target.value.replace(/\D/g, "").slice(0, 3);
          setDraft(text);
          if (text) set(Number(text));
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            setDraft(null);
            set(shown + (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1));
          } else if (e.key === "Enter" || e.key === "Escape") {
            setDraft(null);
          }
        }}
        className={cx(FIELD, "text-right")}
      />
    </label>
  );
}

/** Hex entry: six digits apply while typing; "#48c" shorthand applies on Enter or when leaving the field. */
export function HexInput({ value, onChange, className }: { value: string; onChange: (hex: string) => void; className?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const settle = () => {
    const hex = draft === null ? null : parseHex(draft);
    if (hex && hex !== value.toLowerCase()) onChange(hex);
    setDraft(null);
  };
  return (
    <input
      aria-label="Hex"
      title="Hex colour, like #4a82cc or #48c"
      spellCheck={false}
      autoComplete="off"
      maxLength={7}
      value={draft ?? value.toLowerCase()}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const hex = /^#?[0-9a-f]{6}$/i.test(text.trim()) ? parseHex(text) : null;
        if (hex && hex !== value.toLowerCase()) onChange(hex);
      }}
      onBlur={settle}
      onKeyDown={(e) => {
        if (e.key === "Enter") settle();
        else if (e.key === "Escape") setDraft(null);
      }}
      className={cx(FIELD, className)}
    />
  );
}
