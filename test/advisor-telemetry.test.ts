import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { type Account, confirmApiObservations, defaults } from "../src/advisor.ts";
import { snapshots } from "../src/advisor-telemetry.ts";

it("exports all accounts without identifiers, marks unknown runway and excludes stale quotas", () => {
  const now = 1800000000;
  const a: Account = {
    account_key: "private-account",
    number: 1,
    active: true,
    usage: {
      source: "api",
      refresh: { status: "ok" },
      updated_at: now,
      primary: { used_percent: 50, resets_at: now + 3600, window_minutes: 300 },
      secondary: null,
      reset_credit: [{ status: "available", expires_at: new Date((now + 7200) * 1000).toISOString() }],
    },
  };
  assert(a.usage);
  const out = snapshots(
    [a, { ...a, account_key: "another-private", number: 2, usage: { ...a.usage, updated_at: now - 10000 } }],
    {},
    [{ hours: 24, probability: 0.6 }],
    now,
    defaults,
  );
  expect(JSON.stringify(out)).not.toContain("private");
  expect(out.filter((e) => e.event === "account_status")).toHaveLength(2);
  const usage = out.filter((e) => e.event === "usage_snapshot");
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ remaining_percent: 50 });
  expect(usage[0]).toMatchObject({ runway_hours: -1, rate_pph: -1 });
  expect(out.find((e) => e.event === "credit_snapshot")).toMatchObject({
    credits_available: 1,
    credit_expiry_at: now + 7200,
  });
  expect(out.find((e) => e.event === "forecast_snapshot")).toMatchObject({ probability: 0.6, horizon_hours: 24 });
  expect(snapshots([], {}, null, now, defaults)).toEqual([]);
  const old = {
    ...a,
    usage: { ...a.usage, updated_at: now - 10000, refresh: { status: "ok", method: "api", requested: true } },
  };
  const confirmed = confirmApiObservations([old], now);
  expect(confirmed[0]?.usage?.updated_at).toBe(now);
  expect(snapshots(confirmed, {}, null, now, defaults).some((e) => e.event === "usage_snapshot")).toBe(true);
  expect(
    confirmApiObservations(
      [{ ...old, usage: { ...old.usage, refresh: { status: "error", method: "api", requested: true } } }],
      now,
    )[0]?.usage?.updated_at,
  ).toBe(now - 10000);
  expect(
    confirmApiObservations(
      [{ ...old, usage: { ...old.usage, refresh: { status: "ok", method: "api", requested: false } } }],
      now,
    )[0]?.usage?.updated_at,
  ).toBe(now - 10000);
});
