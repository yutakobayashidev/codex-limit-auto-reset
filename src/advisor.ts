import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";

const windowSchema = z.object({
  used_percent: z.number().min(0).max(100),
  window_minutes: z.number().positive(),
  resets_at: z.number().positive(),
});
export const accountsSchema = z.object({
  schema_version: z.literal(1),
  accounts: z.array(
    z.object({
      account_key: z.string().min(1),
      number: z.union([z.string(), z.number()]),
      active: z.boolean(),
      plan: z.string().nullable().optional(),
      usage: z
        .object({
          source: z.string(),
          updated_at: z.number(),
          primary: windowSchema.nullable(),
          secondary: windowSchema.nullable(),
          reset_credit: z.array(z.object({ status: z.string(), expires_at: z.string().nullable() })).default([]),
          refresh: z.object({ status: z.string() }),
        })
        .nullable(),
    }),
  ),
});
export type Account = z.infer<typeof accountsSchema>["accounts"][number];
export const sampleSchema = z.object({ at: z.number(), used: z.number(), reset: z.number(), active: z.boolean() });
export type Sample = z.infer<typeof sampleSchema>;
export type History = Record<string, Sample[]>;
export const stateSchema = z.object({
  version: z.literal(1),
  history: z.record(z.string(), z.array(sampleSchema)),
  last: z.object({ fingerprint: z.string(), sentAt: z.number() }).nullable(),
});
export type State = z.infer<typeof stateSchema>;
export type Options = {
  lowPercent: number;
  warningHours: number;
  minSamples: number;
  minSpanSeconds: number;
  historySeconds: number;
  maxGapSeconds: number;
  maxAgeSeconds: number;
  probabilityThreshold: number;
  expiryHours: number;
  cooldownSeconds: number;
};
export const defaults: Options = {
  lowPercent: 20,
  warningHours: 2,
  minSamples: 4,
  minSpanSeconds: 900,
  historySeconds: 21600,
  maxGapSeconds: 900,
  maxAgeSeconds: 900,
  probabilityThreshold: 0.7,
  expiryHours: 6,
  cooldownSeconds: 21600,
};
export const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 20);
const windows = (a: Account) => [a.usage?.primary, a.usage?.secondary].filter((x) => x != null);
export const fresh = (a: Account, now: number, options: Options) =>
  a.usage?.source === "api" &&
  a.usage.refresh.status === "ok" &&
  a.usage.updated_at <= now + 60 &&
  now - a.usage.updated_at <= options.maxAgeSeconds &&
  windows(a).length > 0 &&
  windows(a).every((w) => w.resets_at > now);

export function observe(accounts: Account[], previous: History, now: number, options: Options): History {
  const history: History = {};
  for (const a of accounts.filter((a) => fresh(a, now, options))) {
    assert(a.usage);
    for (const w of windows(a)) {
      const id = key(`${a.account_key}:${w.window_minutes}`);
      let samples = (previous[id] ?? []).filter((s) => now - s.at <= options.historySeconds && s.at <= now);
      const last = samples.at(-1);
      if (last && (last.reset !== w.resets_at || last.used > w.used_percent)) samples = [];
      if (!last || a.usage.updated_at > last.at)
        samples.push({ at: a.usage.updated_at, used: w.used_percent, reset: w.resets_at, active: a.active });
      history[id] = samples.slice(-200);
    }
  }
  return history;
}

// Only active-use intervals count. Idle accounts must not acquire an infinite runway.
export function rate(samples: Sample[], options: Options): number | null {
  let seconds = 0;
  let used = 0;
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    assert(a && b);
    const dt = b.at - a.at;
    if (!a.active || !b.active || dt <= 0 || dt > options.maxGapSeconds || a.reset !== b.reset || b.used < a.used)
      continue;
    seconds += dt;
    used += b.used - a.used;
    count++;
  }
  if (count + 1 < options.minSamples || seconds < options.minSpanSeconds || used <= 0) return null;
  // One percentage point of rounding margin, rather than false precision.
  return ((used + 1) * 3600) / seconds;
}

const forecastSchema = z.object({
  state: z.literal("forecast"),
  asOf: z.string(),
  expiresAt: z.string(),
  degraded: z.literal(false),
  checks: z.object({ history: z.object({ ok: z.literal(true) }), social: z.object({ ok: z.literal(true) }) }),
  windows: z.array(z.object({ hours: z.number().positive(), probability: z.number().min(0).max(1) })),
});
export type Forecast = { hours: number; probability: number }[];
export function forecast(raw: unknown, now: number): Forecast | null {
  const result = forecastSchema.safeParse(raw);
  if (!result.success) return null;
  const d = result.data;
  const at = Date.parse(d.asOf) / 1000;
  const expires = Date.parse(d.expiresAt) / 1000;
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(expires) ||
    at > now + 60 ||
    now - at > 3600 ||
    expires <= now ||
    expires <= at
  )
    return null;
  return [...d.windows].sort((a, b) => a.hours - b.hours);
}

type Health = { a: Account; remaining: number; hours: number | null; naturalSafe: boolean; expiry: number | null };
function health(a: Account, history: History, now: number, options: Options): Health {
  const ws = windows(a);
  const times = ws.map((w) => {
    const r = rate(history[key(`${a.account_key}:${w.window_minutes}`)] ?? [], options);
    return {
      hours: w.used_percent >= 100 ? 0 : r === null ? null : (100 - w.used_percent) / r,
      untilReset: (w.resets_at - now) / 3600,
    };
  });
  const expiries = (a.usage?.reset_credit ?? [])
    .filter((c) => c.status === "available" && c.expires_at)
    .map((c) => Date.parse(c.expires_at ?? "") / 1000)
    .filter((t) => Number.isFinite(t) && t > now);
  return {
    a,
    remaining: Math.min(...ws.map((w) => 100 - w.used_percent)),
    hours: times.some((t) => t.hours === 0)
      ? 0
      : times.some((t) => t.hours === null)
        ? null
        : Math.min(...times.map((t) => t.hours ?? Number.POSITIVE_INFINITY)),
    naturalSafe: times.every((t) => t.hours !== null && t.hours >= t.untilReset),
    expiry: expiries.length ? Math.min(...expiries) : null,
  };
}
export type Advice = { kind: string; fingerprint: string; summary: string; description: string };
export function advise(
  accounts: Account[],
  history: History,
  predictions: Forecast | null,
  now: number,
  options: Options,
): Advice | null {
  const valid = accounts.filter((a) => fresh(a, now, options));
  const active = valid.filter((a) => a.active);
  if (active.length !== 1) return null;
  const activeAccount = active[0];
  assert(activeAccount);
  const current = health(activeAccount, history, now, options);
  const candidates = valid.filter((a) => !a.active).map((a) => health(a, history, now, options));
  const prediction = predictions?.find((p) => p.probability >= options.probabilityThreshold);
  const bridges = (h: Health) => prediction !== undefined && h.hours !== null && h.hours >= prediction.hours;
  const atRisk =
    current.remaining <= options.lowPercent || (current.hours !== null && current.hours <= options.warningHours);
  const expiring = [current, ...candidates].filter(
    (h) => h.expiry !== null && h.expiry - now <= options.expiryHours * 3600,
  );
  if (!atRisk && !expiring.length) return null;
  const label = (h: Health) => `アカウント${h.a.number}`;
  const runway = (h: Health) =>
    h.hours === null
      ? "消費履歴不足のため継続時間は不明"
      : `直近の消費ペースで約${h.hours.toFixed(1)}時間（通常回復前の残量換算）`;
  let kind = "observe";
  let target = current;
  let summary = "利用枠の回復状況を確認してください";
  if (atRisk && (current.naturalSafe || bridges(current))) {
    kind = "hold";
    summary = `${label(current)}を継続する案：リセット権を温存`;
  } else if (atRisk && current.expiry !== null && current.expiry - now <= options.expiryHours * 3600) {
    kind = "expiry";
    summary = "切替前に、期限間近のリセット権と回復状況を確認";
  } else if (atRisk) {
    // Unknown candidate speed is not presented as a promise of longer runtime.
    const eligible = candidates.filter(
      (h) => h.remaining > options.lowPercent && h.remaining >= current.remaining + 10,
    );
    eligible.sort(
      (a, b) =>
        Number(bridges(b)) - Number(bridges(a)) ||
        Number(b.naturalSafe) - Number(a.naturalSafe) ||
        b.remaining - a.remaining,
    );
    if (eligible[0]) {
      target = eligible[0];
      kind = "switch";
      summary = `次の作業は${label(target)}への切替を検討`;
    } else {
      kind = "low";
      summary = "残量が少なく、十分な残量の切替候補を確認できません";
    }
  } else {
    kind = "expiry";
    summary = "リセット権の期限が近づいています";
  }
  const describe = (h: Health) =>
    `${label(h)}：最少残量${h.remaining.toFixed(0)}%、${runway(h)}。通常回復まで${windows(h.a)
      .map((w) => `${Math.max(0, (w.resets_at - now) / 3600).toFixed(1)}時間`)
      .join(" / ")}。`;
  const forecastText = predictions?.length
    ? `Tibo予測（未校正）：${predictions.map((p) => `${p.hours}時間以内${Math.round(p.probability * 100)}%`).join(" / ")}。${bridges(target) ? "選択候補の残量見積もりは予測の時間幅をカバーします。" : "回復を待てる根拠としては扱っていません。"}`
    : "Tibo予測は取得不可・古い・無効のため判断に使用していません。";
  const expiryText = expiring
    .map((h) => `${label(h)}のリセット権は約${(((h.expiry ?? now) - now) / 3600).toFixed(1)}時間後に期限。`)
    .join(" ");
  const unknown = accounts.length - valid.length;
  const description = [
    describe(current),
    target !== current ? describe(target) : "",
    forecastText,
    expiryText,
    unknown ? `${unknown}アカウントは最新状態を確認できず候補から除外。` : "",
    "予測・時間は保証ではありません。候補間の残量%は利用可能トークン量の比較ではありません。切替・リセットは実行していません。既存の期限リセットは別途稼働。",
    "予測元：https://nextreset.ai/forecast/",
  ]
    .filter(Boolean)
    .join("\n");
  const fingerprint = key(
    JSON.stringify([
      kind,
      key(current.a.account_key),
      key(target.a.account_key),
      expiring.map((h) => [key(h.a.account_key), h.expiry]),
    ]),
  );
  return { kind, fingerprint, summary, description };
}

export function shouldNotify(advice: Advice, state: State, now: number, options: Options): boolean {
  if (!state.last) return true;
  // Even oscillating choices cannot generate a flood; unchanged advice repeats only after the cooldown.
  return now - state.last.sentAt >= (state.last.fingerprint === advice.fingerprint ? options.cooldownSeconds : 1800);
}
