import type { Account, Forecast, History, Options } from "./advisor.ts";
import { fresh, key, rate } from "./advisor.ts";

// Flat numeric events for Loki. Account identifiers and credentials never leave the host.
export function snapshots(
  accounts: Account[],
  history: History,
  predictions: Forecast | null,
  now: number,
  options: Options,
) {
  const events: Record<string, unknown>[] = [];
  for (const a of accounts) {
    const valid = fresh(a, now, options);
    const base = {
      account: key(a.account_key),
      account_number: String(a.number),
      active: Number(a.active),
      observed_at: now,
      fresh: Number(valid),
    };
    events.push({ event: "account_status", ...base });
    if (!valid || !a.usage) continue;
    const credits = a.usage.reset_credit.filter(
      (c) => c.status === "available" && (c.expires_at === null || Date.parse(c.expires_at) / 1000 > now),
    );
    const expiries = credits.flatMap((c) => (c.expires_at === null ? [] : [Date.parse(c.expires_at) / 1000]));
    events.push({
      event: "credit_snapshot",
      ...base,
      credits_available: credits.length,
      // -1 explicitly clears an older known value; dashboards filter it after last_over_time.
      credit_expiry_at: expiries.length ? Math.min(...expiries) : -1,
    });
    for (const w of [a.usage.primary, a.usage.secondary]) {
      if (!w) continue;
      const speed = rate(history[key(`${a.account_key}:${w.window_minutes}`)] ?? [], options);
      const remaining = 100 - w.used_percent;
      events.push({
        event: "usage_snapshot",
        ...base,
        window_minutes: w.window_minutes,
        remaining_percent: remaining,
        resets_at: w.resets_at,
        rate_pph: speed ?? -1,
        runway_hours: remaining === 0 ? 0 : speed === null ? -1 : remaining / speed,
      });
    }
  }
  for (const p of predictions ?? [])
    events.push({ event: "forecast_snapshot", observed_at: now, horizon_hours: p.hours, probability: p.probability });
  return events;
}
