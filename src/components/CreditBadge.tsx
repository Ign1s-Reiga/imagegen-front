"use client";

import { useEffect } from "react";

import { describeCredit } from "@/providers/credit";
import { provider } from "@/providers/registry";
import type { Connection } from "@/providers/types";
import { useApp } from "@/store/app";

import { cx } from "./ui";

/** Background refresh while the app is open; generations refresh sooner. */
const REFRESH_MS = 5 * 60_000;

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Balance or spend for a connection, refreshed on click. */
export function CreditBadge({ connection }: { connection: Connection }) {
  const credit = useApp((s) => s.credits[connection.id]);
  const loadCredit = useApp((s) => s.loadCredit);
  const supported = Boolean(provider(connection.kind).getCredit);

  useEffect(() => {
    if (!supported) return;
    const timer = setInterval(() => void loadCredit(connection.id, { force: true }), REFRESH_MS);
    return () => clearInterval(timer);
  }, [supported, connection.id, loadCredit]);

  // Nothing to show: unsupported provider, or not set up (e.g. no OpenAI admin key).
  if (!supported || credit?.info === null) return null;

  const refresh = () => void loadCredit(connection.id, { force: true });
  const updated = credit?.updatedAt ? `Updated ${timeFormat.format(credit.updatedAt)}. ` : "";

  let text: string;
  let tone = "text-fg-dim";
  let title: string;
  if (credit?.info) {
    const { headline, details } = describeCredit(credit.info);
    text = headline;
    if (credit.info.low) tone = "text-danger";
    title = [...details, credit.error ? `Last refresh failed: ${credit.error}` : "", `${updated}Click to refresh.`]
      .filter(Boolean)
      .join("\n");
  } else if (credit?.error) {
    text = "Credit unavailable";
    tone = "text-fg-faint";
    title = `${credit.error}\n${updated}Click to try again.`;
  } else {
    text = "Checking credit";
    tone = "text-fg-faint";
    title = "Reading the account balance";
  }

  return (
    <button
      type="button"
      onClick={refresh}
      title={title}
      aria-label={`${text}. ${connection.name}. Refresh`}
      aria-busy={credit?.loading || undefined}
      className={cx(
        "h-7 rounded-[4px] px-2 text-[13px] transition-opacity hover:bg-field",
        tone,
        credit?.loading && credit.info && "opacity-60",
      )}
    >
      {text}
    </button>
  );
}
