"use client";

import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type RefObject, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type ButtonVariant = "primary" | "quiet" | "ghost" | "danger";

const BUTTON: Record<ButtonVariant, string> = {
  primary:
    "bg-safelight text-safelight-ink font-semibold hover:bg-safelight-strong disabled:bg-raised disabled:text-fg-faint",
  quiet: "bg-raised text-fg hover:bg-line-strong disabled:text-fg-faint",
  ghost: "text-fg-dim hover:text-fg hover:bg-raised disabled:text-fg-faint disabled:hover:bg-transparent",
  danger: "text-danger hover:bg-danger/12",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }
>(function Button({ variant = "quiet", size = "md", className, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[4px] transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2 text-[13px]" : "h-8 px-3",
        BUTTON[variant],
        className,
      )}
      {...rest}
    />
  );
});

let openModals = 0;

/**
 * Whether a modal is open: page-wide shortcuts do nothing under one. The
 * count from `useModal` is checked first; the page is also searched for an
 * `aria-modal` element, so a modal that does not count itself is still
 * seen, as is one mounted when a hot reload reset the count.
 */
export const isModalOpen = () => openModals > 0 || document.querySelector('[aria-modal="true"]') !== null;

/** Counts the component as an open modal for `isModalOpen` while it is mounted. */
export function useModal() {
  useEffect(() => {
    openModals++;
    return () => {
      // Never below zero, should a hot reload have reset the count meanwhile.
      openModals = Math.max(0, openModals - 1);
    };
  }, []);
}

/**
 * Puts focus back where it was when the component mounted, on unmount: a
 * modal takes focus, and without this closing it leaves focus on the page
 * body, so a keyboard user starts over from the top.
 */
export function useRestoreFocus() {
  // Read on the first render, before any effect or autoFocus inside the
  // component has moved focus in; an effect here runs after its children's.
  const [previous] = useState(() => (typeof document === "undefined" ? null : document.activeElement));
  useEffect(
    () => () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    },
    [previous],
  );
}

/**
 * A modal over a dimmed backdrop: it focuses its first control on open and
 * gives focus back to what had it on close, and Escape or a press on the
 * backdrop closes it. The Escape listener is on the window's capture phase and
 * stops propagation, so elements and bubbling listeners (such as the pixel
 * page clearing its selection) never see that Escape; other window capture
 * listeners still do. `className` sizes and lays out the panel.
 */
export function Dialog({
  label,
  onClose,
  className,
  initialFocus,
  closeOnBackdrop = true,
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  /**
   * The control to focus on open, when it is not the first one, or "panel"
   * for the panel itself (a form whose first field should not take keys yet).
   */
  initialFocus?: RefObject<HTMLElement | null> | "panel";
  /** False where a stray press outside would throw away edits. */
  closeOnBackdrop?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModal();
  useRestoreFocus();
  // Focus moves in once, on open: a caller passing a new `onClose` each
  // render would otherwise pull focus back to the first control as it types.
  useEffect(() => {
    if (initialFocus === "panel") ref.current?.focus();
    else (initialFocus?.current ?? ref.current?.querySelector<HTMLElement>("input, select, textarea, button"))?.focus();
  }, [initialFocus]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/55 p-6"
      onPointerDown={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={initialFocus === "panel" ? -1 : undefined}
        className={cx("rounded-[6px] bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.5)] outline-none", className)}
      >
        {children}
      </div>
    </div>
  );
}

export function IconButton({
  label,
  className,
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-7 items-center justify-center rounded-[4px] transition-colors hover:bg-raised disabled:opacity-40",
        active ? "text-safelight" : "text-fg-dim hover:text-fg",
        className,
      )}
      {...rest}
    />
  );
}

export function Field({
  label,
  help,
  children,
  aside,
  htmlFor,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg-dim">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {help && <p className="text-[12.5px] leading-snug text-fg-faint">{help}</p>}
    </div>
  );
}

const FIELD_BASE =
  "w-full rounded-[4px] border border-transparent bg-field px-2.5 text-fg placeholder:text-fg-faint hover:border-line focus:border-safelight/70 focus:outline-none";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(FIELD_BASE, "h-8", className)} {...rest} />;
});

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  className,
  id,
  allowEmpty,
  ariaLabel,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  className?: string;
  id?: string;
  allowEmpty?: boolean;
  ariaLabel?: string;
}) {
  return (
    <input
      id={id}
      aria-label={ariaLabel}
      type="number"
      inputMode="decimal"
      className={cx(FIELD_BASE, "h-8", className)}
      value={value ?? ""}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(allowEmpty ? null : (min ?? 0));
        const parsed = Number(raw);
        if (!Number.isNaN(parsed)) onChange(parsed);
      }}
    />
  );
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(FIELD_BASE, "resize-none py-2 leading-relaxed", className)} {...rest} />;
  },
);

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={cx(FIELD_BASE, "h-8 appearance-auto pr-1", className)} {...rest}>
      {children}
    </select>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded-[5px] bg-field p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className={cx(
            "h-7 rounded-[4px] px-2 text-[13px] transition-colors disabled:cursor-not-allowed disabled:text-fg-faint",
            value === option.value ? "bg-raised font-medium text-fg" : "text-fg-dim hover:text-fg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function useFieldId(prefix: string) {
  return `${prefix}-${useId()}`;
}

/** The framing device for an image on the stage: printer's crop marks. */
export function CropMarks() {
  const mark = "pointer-events-none absolute size-4 border-fg-faint/80";
  return (
    <>
      <span aria-hidden className={cx(mark, "-left-3 -top-3 border-l border-t")} />
      <span aria-hidden className={cx(mark, "-right-3 -top-3 border-r border-t")} />
      <span aria-hidden className={cx(mark, "-bottom-3 -left-3 border-b border-l")} />
      <span aria-hidden className={cx(mark, "-bottom-3 -right-3 border-b border-r")} />
    </>
  );
}
