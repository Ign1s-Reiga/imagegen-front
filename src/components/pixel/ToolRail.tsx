"use client";

import {
  Eraser,
  FlipHorizontal2,
  FlipVertical2,
  Move,
  PaintBucket,
  Pencil,
  Pipette,
  Slash,
  Square,
  SquareDashed,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { usePixel, type Tool } from "@/pixel/store";

import { cx } from "../ui";

export const TOOLS: { tool: Tool; label: string; key: string; icon: LucideIcon }[] = [
  { tool: "pencil", label: "Pencil", key: "B", icon: Pencil },
  { tool: "eraser", label: "Eraser", key: "E", icon: Eraser },
  { tool: "fill", label: "Fill", key: "G", icon: PaintBucket },
  { tool: "picker", label: "Pick colour", key: "I", icon: Pipette },
  { tool: "line", label: "Line", key: "L", icon: Slash },
  { tool: "rect", label: "Rectangle", key: "U", icon: Square },
  { tool: "select", label: "Select area", key: "M", icon: SquareDashed },
  { tool: "move", label: "Move", key: "V", icon: Move },
];

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "relative flex size-9 items-center justify-center rounded-[4px] transition-colors",
        active ? "bg-raised text-safelight" : "text-fg-dim hover:bg-field hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function ToolRail() {
  const tool = usePixel((s) => s.tool);
  const mirror = usePixel((s) => s.mirror);
  const setTool = usePixel((s) => s.setTool);
  const toggleMirror = usePixel((s) => s.toggleMirror);

  return (
    <nav aria-label="Tools" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2">
      {TOOLS.map(({ tool: t, label, key, icon: Icon }) => (
        <RailButton key={t} label={`${label} (${key})`} active={tool === t} onClick={() => setTool(t)}>
          <Icon size={17} strokeWidth={1.75} />
        </RailButton>
      ))}
      <span aria-hidden className="my-1 h-px w-6 bg-line" />
      <RailButton label="Mirror left and right" active={mirror.x} onClick={() => toggleMirror("x")}>
        <FlipHorizontal2 size={17} strokeWidth={1.75} />
      </RailButton>
      <RailButton label="Mirror top and bottom" active={mirror.y} onClick={() => toggleMirror("y")}>
        <FlipVertical2 size={17} strokeWidth={1.75} />
      </RailButton>
    </nav>
  );
}
