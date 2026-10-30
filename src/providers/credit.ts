// Parsing and formatting for account credit. No imports, so it can be tested
// on its own (node --experimental-strip-types, or plain node 23+).

import type { CreditInfo, Money } from "./types";

/** Below this balance (in the account currency) a balance counts as low. */
export const LOW_BALANCE = 2;

const money = (amount: unknown, currency = "USD"): Money | undefined => {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return typeof n === "number" && Number.isFinite(n) ? { amount: n, currency: currency.toUpperCase() } : undefined;
};

/** fal.ai GET /v1/account/billing?expand=credits */
export function parseFalBilling(json: unknown): CreditInfo {
  const credits = (json as { credits?: { current_balance?: unknown; currency?: string } })?.credits;
  const balance = money(credits?.current_balance, credits?.currency ?? "USD");
  if (!balance) throw new Error("fal.ai did not return a credit balance.");
  return { balance, low: balance.amount < LOW_BALANCE };
}

/** RunPod GraphQL `myself { clientBalance currentSpendPerHr spendLimit minBalance underBalance }` */
export function parseRunpodMyself(json: unknown): CreditInfo {
  const body = json as {
    data?: { myself?: Record<string, unknown> | null };
    errors?: { message?: string }[];
  };
  if (body?.errors?.length) {
    throw new Error(body.errors.map((e) => e.message ?? "unknown error").join("; "));
  }
  const me = body?.data?.myself;
  const balance = money(me?.clientBalance);
  if (!me || !balance) throw new Error("RunPod did not return an account balance.");
  const minBalance = typeof me.minBalance === "number" ? me.minBalance : 0;
  const limit = money(me.spendLimit);
  return {
    balance,
    spendPerHour: money(me.currentSpendPerHr),
    spendLimitPerHour: limit && limit.amount > 0 ? limit : undefined,
    low: me.underBalance === true || balance.amount < Math.max(minBalance, LOW_BALANCE),
  };
}

interface CostsPage {
  data?: { results?: { amount?: { value?: unknown; currency?: string } }[] }[];
  has_more?: boolean;
  next_page?: string | null;
}

/** Sums OpenAI /v1/organization/costs pages into one amount. */
export function sumOpenAICosts(pages: CostsPage[]): Money {
  let total = 0;
  let currency = "USD";
  for (const page of pages) {
    for (const bucket of page.data ?? []) {
      for (const result of bucket.results ?? []) {
        const value = Number(result.amount?.value);
        if (Number.isFinite(value)) total += value;
        if (result.amount?.currency) currency = result.amount.currency.toUpperCase();
      }
    }
  }
  return { amount: total, currency };
}

/** Unix seconds at 00:00 UTC on the first day of `now`'s month. */
export const monthStartUnix = (now = new Date()) =>
  Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);

export function formatMoney(value: Money, perHour = false): string {
  let text: string;
  try {
    text = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: value.amount !== 0 && Math.abs(value.amount) < 0.1 ? 3 : 2,
    }).format(value.amount);
  } catch {
    text = `${value.amount.toFixed(2)} ${value.currency}`;
  }
  return perHour ? `${text}/hr` : text;
}

/** One short line for the top bar, plus lines for a tooltip or detail view. */
export function describeCredit(info: CreditInfo): { headline: string; details: string[] } {
  const details: string[] = [];
  let headline = "";
  if (info.balance) headline = `${formatMoney(info.balance)} left`;
  else if (info.monthSpend) headline = `${formatMoney(info.monthSpend)} this month`;
  if (info.balance && info.monthSpend) details.push(`Spent this month: ${formatMoney(info.monthSpend)}`);
  if (info.spendPerHour && info.spendPerHour.amount > 0) {
    details.push(`Spending now: ${formatMoney(info.spendPerHour, true)}`);
  }
  if (info.spendLimitPerHour) details.push(`Spend limit: ${formatMoney(info.spendLimitPerHour, true)}`);
  if (info.low && info.balance) details.push("Balance is low. Add credit before it runs out.");
  return { headline, details };
}
