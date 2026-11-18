import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { State } from "./advisor.ts";
import {
  accountsSchema,
  advise,
  confirmApiObservations,
  defaults,
  forecast,
  observe,
  shouldNotify,
  stateSchema,
} from "./advisor.ts";
import { snapshots } from "./advisor-telemetry.ts";

const config = z
  .object({
    CODEX_AUTH_BIN: z.string().default("codex-auth"),
    ADVISOR_STATE_FILE: z
      .string()
      .default(join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "codex-usage-advisor/state.json")),
    ADVISOR_LOW_PERCENT: z.coerce.number().min(0).max(100).default(defaults.lowPercent),
    ADVISOR_WARNING_HOURS: z.coerce.number().positive().default(defaults.warningHours),
    ADVISOR_PROBABILITY: z.coerce.number().min(0).max(1).default(defaults.probabilityThreshold),
    ADVISOR_EXPIRY_HOURS: z.coerce.number().positive().default(defaults.expiryHours),
    ADVISOR_COOLDOWN_SECONDS: z.coerce.number().int().min(1800).default(defaults.cooldownSeconds),
  })
  .parse(process.env);
const options = {
  ...defaults,
  lowPercent: config.ADVISOR_LOW_PERCENT,
  warningHours: config.ADVISOR_WARNING_HOURS,
  probabilityThreshold: config.ADVISOR_PROBABILITY,
  expiryHours: config.ADVISOR_EXPIRY_HOURS,
  cooldownSeconds: config.ADVISOR_COOLDOWN_SECONDS,
};
const dryRun = process.argv.includes("--dry-run");
const log = (value: unknown) => console.log(JSON.stringify(value));
const lockPath = `${config.ADVISOR_STATE_FILE}.lock`;
// Kernel lock is released even on SIGKILL. Dry runs never write state or emit alert events.
if (!dryRun && !process.argv.includes("--lock-held")) {
  const script = process.argv[1];
  assert(script);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const result = await execa(
    process.env.FLOCK_BIN ?? "flock",
    ["--nonblock", lockPath, process.execPath, ...process.execArgv, script, "--lock-held"],
    { stdio: "inherit", reject: false },
  );
  process.exit(result.exitCode ?? 1);
}
try {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  let state: State;
  try {
    state = stateSchema.parse(JSON.parse(await readFile(config.ADVISOR_STATE_FILE, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = { version: 1, history: {}, last: null };
  }
  const { stdout } = await execa(config.CODEX_AUTH_BIN, ["list", "--api", "--json"], {
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const accounts = confirmApiObservations(accountsSchema.parse(JSON.parse(stdout)).accounts, Date.now() / 1000);
  let raw: unknown = null;
  try {
    const res = await fetch("https://nextreset.ai/api/forecast", {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "codex-usage-advisor/0.1" },
    });
    if (res.ok) {
      const text = await res.text();
      if (text.length <= 1024 * 1024) raw = JSON.parse(text);
    }
  } catch {
    /* A forecast failure must not hide observed quota warnings. */
  }
  const now = Date.now() / 1000;
  state.history = observe(accounts, state.history, now, options);
  const predictions = forecast(raw, now);
  const advice = advise(accounts, state.history, predictions, now, options);
  if (!dryRun) {
    for (const event of snapshots(accounts, state.history, predictions, now, options)) log(event);
    log({
      event: "advisor_status",
      observed_at: now,
      accounts: accounts.length,
      forecast_valid: Number(predictions !== null),
      recommendation: advice?.kind ?? "none",
    });
  }
  if (advice && (dryRun || shouldNotify(advice, state, now, options))) {
    log({
      event: dryRun ? "advisory_preview" : "usage_advice",
      advice_id: advice.fingerprint,
      kind: advice.kind,
      summary: advice.summary,
      description: advice.description,
    });
    if (!dryRun) state.last = { fingerprint: advice.fingerprint, sentAt: now };
  } else
    log({
      event: "advisor_checked",
      accounts: accounts.length,
      forecast_valid: predictions !== null,
      recommendation: advice?.kind ?? "none",
    });
  if (!dryRun) {
    await writeFile(`${config.ADVISOR_STATE_FILE}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${config.ADVISOR_STATE_FILE}.tmp`, config.ADVISOR_STATE_FILE);
  }
} catch (e) {
  log({
    event: "advisor_failed",
    error_type: (e as NodeJS.ErrnoException).code === "EEXIST" ? "locked" : "operation_failed",
  });
  process.exitCode = 1; // Never log raw credentials, account JSON or subprocess errors.
}
