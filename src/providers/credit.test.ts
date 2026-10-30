import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeCredit,
  formatMoney,
  monthStartUnix,
  parseFalBilling,
  parseRunpodMyself,
  sumOpenAICosts,
} from "./credit.ts";

test("fal.ai billing: documented example", () => {
  const info = parseFalBilling({ username: "my-team", credits: { current_balance: 24.5, currency: "USD" } });
  assert.deepEqual(info, { balance: { amount: 24.5, currency: "USD" }, low: false });
  assert.equal(describeCredit(info).headline, "$24.50 left");
});

test("fal.ai billing: low balance and missing credits", () => {
  assert.equal(parseFalBilling({ credits: { current_balance: 0.4, currency: "usd" } }).low, true);
  assert.throws(() => parseFalBilling({ username: "x" }), /did not return a credit balance/);
});

test("RunPod myself: balance, burn rate, limit", () => {
  const info = parseRunpodMyself({
    data: { myself: { clientBalance: 435.85, currentSpendPerHr: 0.42, spendLimit: 180, minBalance: 0, underBalance: false } },
  });
  assert.deepEqual(info.balance, { amount: 435.85, currency: "USD" });
  assert.deepEqual(info.spendPerHour, { amount: 0.42, currency: "USD" });
  assert.deepEqual(info.spendLimitPerHour, { amount: 180, currency: "USD" });
  assert.equal(info.low, false);
  const { headline, details } = describeCredit(info);
  assert.equal(headline, "$435.85 left");
  assert.deepEqual(details, ["Spending now: $0.42/hr", "Spend limit: $180.00/hr"]);
});

test("RunPod myself: underBalance, string numbers, zero limit, idle", () => {
  const info = parseRunpodMyself({
    data: { myself: { clientBalance: "12.50", currentSpendPerHr: 0, spendLimit: 0, minBalance: 20, underBalance: false } },
  });
  assert.equal(info.balance?.amount, 12.5);
  assert.equal(info.spendLimitPerHour, undefined);
  assert.equal(info.low, true, "below minBalance counts as low");
  assert.deepEqual(describeCredit(info).details, ["Balance is low. Add credit before it runs out."]);
  assert.equal(parseRunpodMyself({ data: { myself: { clientBalance: 99, underBalance: true } } }).low, true);
});

test("RunPod myself: GraphQL errors surface", () => {
  assert.throws(
    () => parseRunpodMyself({ errors: [{ message: "Unauthorized" }, { message: "Bad key" }], data: { myself: null } }),
    /Unauthorized; Bad key/,
  );
  assert.throws(() => parseRunpodMyself({ data: { myself: null } }), /did not return an account balance/);
});

test("OpenAI costs: documented example and multiple pages", () => {
  const documented = {
    object: "page",
    data: [
      {
        object: "bucket",
        start_time: 1730419200,
        end_time: 1730505600,
        results: [{ object: "organization.costs.result", amount: { value: 0.06, currency: "usd" }, line_item: null, project_id: null }],
      },
    ],
    has_more: false,
    next_page: null,
  };
  assert.deepEqual(sumOpenAICosts([documented]), { amount: 0.06, currency: "USD" });
  const second = { data: [{ results: [{ amount: { value: 1.2, currency: "usd" } }, { amount: { value: 0.74, currency: "usd" } }] }, { results: [] }] };
  const total = sumOpenAICosts([documented, second]);
  assert.ok(Math.abs(total.amount - 2.0) < 1e-9);
  assert.equal(describeCredit({ monthSpend: total }).headline, "$2.00 this month");
  assert.deepEqual(sumOpenAICosts([{ data: [] }]), { amount: 0, currency: "USD" });
});

test("month start is 00:00 UTC on day 1", () => {
  assert.equal(monthStartUnix(new Date("2026-10-30T15:00:00Z")), Date.UTC(2026, 9, 1) / 1000);
  assert.equal(monthStartUnix(new Date("2026-01-01T00:00:00Z")), Date.UTC(2026, 0, 1) / 1000);
});

test("money formatting", () => {
  assert.equal(formatMoney({ amount: 0.042, currency: "USD" }, true), "$0.042/hr");
  assert.equal(formatMoney({ amount: 1234.5, currency: "USD" }), "$1,234.50");
  assert.match(formatMoney({ amount: 3, currency: "NOT-A-CODE" }), /3\.00 NOT-A-CODE/);
});
