"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useApp } from "@/store/app";

import { TopBar } from "./TopBar";
import { isModalOpen } from "./ui";

/** Loads app state once and frames every route with the top bar. */
export function AppShell({ children }: { children: ReactNode }) {
  const ready = useApp((s) => s.ready);
  const init = useApp((s) => s.init);
  const notice = useApp((s) => s.notice);
  const notify = useApp((s) => s.notify);
  const pathname = usePathname();
  const router = useRouter();
  const [initError, setInitError] = useState<string | null>(null);
  const routedFirstRun = useRef(false);

  useEffect(() => {
    init().catch((err) => setInitError(err instanceof Error ? err.message : String(err)));
  }, [init]);

  // First run: nothing to generate with yet, so start on Connections.
  useEffect(() => {
    if (!ready || routedFirstRun.current) return;
    routedFirstRun.current = true;
    if (useApp.getState().connections.length === 0 && pathname === "/") router.replace("/connections");
  }, [ready, pathname, router]);

  useEffect(() => {
    if (!notice) return;
    // Long enough to read: 70 ms a character (about 14 a second), so a
    // long message such as a list of workflow names and an error stays
    // longer, but never under 5 seconds or over 20.
    const timer = setTimeout(() => notify(null), Math.min(20_000, Math.max(5000, notice.length * 70)));
    return () => clearTimeout(timer);
  }, [notice, notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && pathname === "/") {
        // A dialog (the full error, the workflow or mask editor) covers the
        // form, so the shortcut would start a run the user cannot see begin.
        if (isModalOpen()) return;
        e.preventDefault();
        void useApp.getState().generate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname]);

  if (initError) {
    return (
      <main className="grid h-full place-items-center p-8">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold">ImageGen could not start</h1>
          <p className="mt-2 text-fg-dim">{initError}</p>
          <p className="mt-2 text-fg-faint">
            This page needs the desktop app. Run <code className="text-fg">pnpm tauri dev</code> instead of opening it
            in a browser.
          </p>
        </div>
      </main>
    );
  }

  if (!ready) return <main className="h-full bg-surround" />;

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className="min-h-0 flex-1">{children}</main>
      {notice && (
        <div
          role="status"
          className="pointer-events-none fixed left-1/2 top-1.5 z-50 max-w-[min(640px,56vw)] -translate-x-1/2 rounded-[5px] bg-raised px-4 py-1.5 text-[13px] leading-snug text-fg shadow-[0_6px_24px_rgba(0,0,0,0.45)]"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
