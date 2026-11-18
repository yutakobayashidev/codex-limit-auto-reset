// biome-ignore-all lint/style/noNonNullAssertion: Fixtures deliberately supply usage windows and expected advice.
import { describe, expect, it } from "vitest";
import type { Account, History, Sample } from "../src/advisor.ts";
import { accountsSchema, advise, defaults, forecast, key, observe, rate, shouldNotify } from "../src/advisor.ts";

const now = 1_800_000_000;
function account(id: string, used = 90, active = false): Account {
  return {
    account_key: id,
    number: id,
    active,
    plan: "pro",
    usage: {
      source: "api",
      updated_at: now,
      primary: { used_percent: used, window_minutes: 10080, resets_at: now + 48 * 3600 },
      secondary: null,
      reset_credit: [],
      refresh: { status: "ok" },
    },
  };
}
function history(a: Account, usedPerSample = 1): History {
  return {
    [key(`${a.account_key}:10080`)]: Array.from({ length: 4 }, (_, i) => ({
      at: now - (3 - i) * 300,
      used: a.usage!.primary!.used_percent - (3 - i) * usedPerSample,
      reset: a.usage!.primary!.resets_at,
      active: true,
    })),
  };
}
const rawForecast = {
  state: "forecast",
  asOf: new Date(now * 1000).toISOString(),
  expiresAt: new Date((now + 900) * 1000).toISOString(),
  degraded: false,
  checks: { history: { ok: true }, social: { ok: true } },
  windows: [{ hours: 24, probability: 0.8 }],
};
describe("forecast validity", () => {
  it("accepts fresh forecast but rejects stale, future, degraded, failed checks and malformed probabilities", () => {
    expect(forecast(rawForecast, now)).toEqual([{ hours: 24, probability: 0.8 }]);
    for (const patch of [
      { expiresAt: new Date((now - 1) * 1000).toISOString() },
      { asOf: "invalid" },
      { asOf: new Date((now + 3600) * 1000).toISOString() },
      { degraded: true },
      { checks: { history: { ok: false }, social: { ok: true } } },
      { windows: [{ hours: 24, probability: 95 }] },
    ]) {
      expect(forecast({ ...rawForecast, ...patch }, now)).toBeNull();
    }
  });
});
describe("consumption history", () => {
  it("requires active consumption, enough time and samples", () => {
    const a = account("A");
    const samples = Object.values(history(a))[0]!;
    expect(rate(samples, defaults)).toBe(16);
    expect(rate(samples.slice(1), defaults)).toBeNull();
    expect(
      rate(
        samples.map((s) => ({ ...s, active: false })),
        defaults,
      ),
    ).toBeNull();
    expect(
      rate(
        samples.map((s) => ({ ...s, used: 10 })),
        defaults,
      ),
    ).toBeNull();
    expect(
      rate(
        samples.map((s, i) => ({ ...s, at: now - (3 - i) * 1800 })),
        defaults,
      ),
    ).toBeNull();
  });
  it("clears history on quota reset and deduplicates a repeated snapshot", () => {
    const a = account("A", 90, true);
    const h = observe([a], history(a), now, defaults);
    expect(Object.values(h)[0]).toHaveLength(4);
    a.usage!.primary!.used_percent = 0;
    a.usage!.updated_at = now + 300;
    const reset = observe([a], h, now + 300, defaults);
    expect(Object.values(reset)[0]).toHaveLength(1);
  });
  it("retains samples and estimates consumption across deadline jitter", () => {
    const a = account("A", 40, true);
    const anchor = a.usage!.primary!.resets_at;
    let h: History = {};
    for (const [i, offset] of [0, 1, 0, -1, 5].entries()) {
      a.usage!.updated_at = now + i * 300;
      a.usage!.primary!.resets_at = anchor + offset;
      a.usage!.primary!.used_percent = 40 + i;
      h = observe([a], h, now + i * 300, defaults);
    }
    const samples = Object.values(h)[0]!;
    expect(samples).toHaveLength(5);
    expect(samples.every((s) => s.reset === anchor)).toBe(true);
    expect(rate(samples, defaults)).toBe(15);
    // Already stored, unnormalised samples use the same jitter tolerance.
    expect(
      rate(
        samples.map((s, i) => ({ ...s, reset: anchor + (i % 2) })),
        defaults,
      ),
    ).toBe(15);
  });
  it("bounds cumulative deadline drift and splits on a real window change", () => {
    const a = account("A", 40, true);
    const anchor = a.usage!.primary!.resets_at;
    let h = observe([a], {}, now, defaults);
    for (const [i, offset] of [3, 6].entries()) {
      a.usage!.updated_at = now + (i + 1) * 300;
      a.usage!.primary!.resets_at = anchor + offset;
      a.usage!.primary!.used_percent++;
      h = observe([a], h, a.usage!.updated_at, defaults);
    }
    expect(Object.values(h)[0]).toHaveLength(1);
    a.usage!.updated_at += 300;
    a.usage!.primary!.resets_at += 86400;
    h = observe([a], h, a.usage!.updated_at, defaults);
    expect(Object.values(h)[0]).toHaveLength(1);
  });
  it("still splits on decreased usage even if the deadline only shifts one second", () => {
    const a = account("A", 90, true);
    const h = history(a);
    a.usage!.updated_at += 300;
    a.usage!.primary!.resets_at++;
    a.usage!.primary!.used_percent = 1;
    expect(Object.values(observe([a], h, now + 300, defaults))[0]).toHaveLength(1);
  });
  it("removes stale accounts from observations", () => {
    const a = account("A");
    a.usage!.refresh.status = "failed";
    expect(observe([a], history(a), now, defaults)).toEqual({});
  });
});
describe("multi-account advisory decisions", () => {
  it("compares every registered account and chooses a healthy alternative", () => {
    const a = account("A", 95, true),
      b = account("B", 70),
      c = account("C", 10);
    const advice = advise([a, b, c], history(a), null, now, defaults)!;
    expect(advice.kind).toBe("switch");
    expect(advice.summary).toContain("C");
    expect(advice.description).toContain("消費履歴不足");
    expect(advice.description).toContain("切替・リセットは実行していません");
  });
  it("does not interpret a 24h probability as recovery before a 1h runway", () => {
    const a = account("A", 90, true),
      b = account("B", 10);
    expect(advise([a, b], history(a), [{ hours: 24, probability: 0.99 }], now, defaults)?.kind).toBe("switch");
  });
  it("forecast can conserve a credit only when its actual horizon is covered", () => {
    const a = account("A", 85, true),
      b = account("B", 10);
    const options = { ...defaults, minSpanSeconds: 7200, maxGapSeconds: 3600 };
    const samples: Sample[] = Array.from({ length: 4 }, (_, i) => ({
      at: now - (3 - i) * 3600,
      used: 82 + i,
      reset: a.usage!.primary!.resets_at,
      active: true,
    }));
    const h = { [key("A:10080")]: samples };
    expect(advise([a, b], h, [{ hours: 6, probability: 0.8 }], now, options)?.kind).toBe("hold");
    expect(advise([a, b], h, [{ hours: 24, probability: 0.8 }], now, options)?.kind).toBe("switch");
  });
  it("checks all quota windows, including one exhausted window", () => {
    const a = account("A", 1, true),
      b = account("B", 10);
    a.usage!.secondary = { used_percent: 100, window_minutes: 300, resets_at: now + 3600 };
    expect(advise([a, b], {}, null, now, defaults)?.kind).toBe("switch");
  });
  it("surviving normal recovery avoids needless switching", () => {
    const a = account("A", 90, true),
      b = account("B", 10);
    a.usage!.primary!.resets_at = now + 300;
    expect(advise([a, b], history(a), null, now, defaults)?.kind).toBe("hold");
  });
  it("includes expiry and checks it before advising a switch", () => {
    const a = account("A", 95, true),
      b = account("B", 10);
    a.usage!.reset_credit = [{ status: "available", expires_at: new Date((now + 3600) * 1000).toISOString() }];
    const advice = advise([a, b], {}, null, now, defaults)!;
    expect(advice.kind).toBe("expiry");
    expect(advice.description).toContain("1.0時間後に期限");
  });
  it("rejects stale or failed candidates even with a cached balance", () => {
    const a = account("A", 95, true),
      b = account("B", 0);
    b.usage!.updated_at = now - 3600;
    const advice = advise([a, b], {}, null, now, defaults)!;
    expect(advice.kind).toBe("low");
    expect(advice.description).toContain("1アカウント");
  });
  it("does not send routine healthy-account messages or infer a missing active account", () => {
    expect(advise([account("A", 10, true)], {}, null, now, defaults)).toBeNull();
    expect(advise([account("A", 95)], {}, null, now, defaults)).toBeNull();
  });
  it("never parses auth JSON as an executable action", () => {
    expect(accountsSchema.safeParse({ schema_version: 2, accounts: [] }).success).toBe(false);
  });
});
it("deduplicates stable advice and bounds oscillation", () => {
  const advice = advise([account("A", 95, true)], {}, null, now, defaults)!;
  const state = { version: 1 as const, history: {}, last: { fingerprint: advice.fingerprint, sentAt: now } };
  expect(shouldNotify(advice, state, now + 300, defaults)).toBe(false);
  expect(shouldNotify(advice, state, now + 21600, defaults)).toBe(true);
  expect(shouldNotify({ ...advice, fingerprint: "other" }, state, now + 300, defaults)).toBe(false);
  expect(shouldNotify({ ...advice, fingerprint: "other" }, state, now + 1800, defaults)).toBe(true);
});
