"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";

import { isRoute } from "@/lib/routes";
import { usePixel } from "@/pixel/store";
import { connectionLabel, isImageConnection } from "@/providers/registry";
import { activeConnection, useApp } from "@/store/app";

import { CreditBadge } from "./CreditBadge";
import { cx } from "./ui";

const TABS = [
  { href: "/", label: "Generate" },
  { href: "/pixel", label: "Pixel" },
  { href: "/gallery", label: "Gallery" },
  { href: "/connections", label: "Connections" },
] as const;

export function TopBar() {
  const pathname = usePathname();
  const connections = useApp((s) => s.connections);
  // Only image backends; Claude connections serve the assistant.
  const backends = useMemo(() => connections.filter(isImageConnection), [connections]);
  const active = useApp(activeConnection);
  const selectConnection = useApp((s) => s.selectConnection);
  const generating = useApp((s) => s.job?.status === "running");
  const pixelRunning = usePixel((s) => s.aiJob !== null);
  // Switching backends mid-run would mix up which connection the result belongs to.
  const running = generating || pixelRunning;

  return (
    <header className="flex h-11 shrink-0 items-center gap-6 border-b border-line bg-panel pl-4 pr-3">
      <span className="font-serif text-[17px] italic tracking-tight text-fg">ImageGen</span>

      <nav className="flex h-full items-stretch gap-1" aria-label="Views">
        {TABS.map((tab) => {
          const current = isRoute(pathname, tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={current ? "page" : undefined}
              className={cx(
                "relative flex items-center px-3 text-[14px] transition-colors",
                current ? "font-medium text-fg" : "text-fg-dim hover:text-fg",
              )}
            >
              {tab.label}
              {current && <span className="absolute inset-x-3 bottom-0 h-0.5 bg-safelight" />}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {active && <CreditBadge key={active.id} connection={active} />}
        {backends.length > 0 ? (
          <>
            <label htmlFor="active-connection" className="text-[13px] text-fg-faint">
              Backend
            </label>
            <select
              id="active-connection"
              value={active?.id ?? ""}
              disabled={running}
              onChange={(e) => selectConnection(e.target.value)}
              className="h-7 max-w-64 rounded-[4px] border border-transparent bg-field px-2 text-[13px] text-fg hover:border-line focus:outline-none disabled:opacity-60"
            >
              {backends.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionLabel(c.name, c.kind)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <Link href="/connections" className="text-[13px] text-safelight hover:text-safelight-strong">
            Add a backend to start
          </Link>
        )}
      </div>
    </header>
  );
}
