# Account switching advice (Linux)

The optional advisor polls **all** accounts with `codex-auth list --api --json`.
It never switches accounts or redeems credits. `codex-auth` may refresh authentication
and its own cached usage; this is read-only with respect to quota and account selection.
The expiry worker remains separate. Set `resetRemainingPercent = null` to disable
low-quota redemption without removing the feature or disabling expiry redemption.

Enable `services.codex-limit-auto-reset.advisor.enable` in Home Manager. A systemd
timer runs every five minutes, with a kernel lock to serialize overlapping runs.
Requires codex-auth JSON schema v1, including reset-credit metadata (tested with 0.4.0).
On other platforms the existing reset commands remain unchanged; the advisor wrapper
and systemd integration are Linux-only.

## Decisions

- Alert below 20% in any window, an estimated runway under two hours, or a credit
  expiring within six hours. These thresholds are configurable in the HM advisor options.
- Estimate each window separately using up to six hours of observations. Require four
  samples spanning at least 15 minutes; ignore gaps over 15 minutes, decreases and changed
  reset timestamps. Only intervals where that account was selected at both observations
  contribute. This does not measure actual working time or prove no other sessions use it.
- Rate is `(used percentage-point increase + 1 rounding-margin point) / observed hours`.
  Runway is remaining percentage divided by rate. Zero observed consumption means unknown,
  not infinite. Idle time can still dilute the estimate; it is a heuristic, not a guarantee.
- Do not apply one account's percentage consumption rate to another account or plan.
  Candidates with insufficient history explicitly show unknown runtime. Percentage-based
  candidate ordering is only a headroom heuristic, not a comparison of token capacities.
- Compare each window with its own scheduled recovery. Nextreset NR forecast windows are
  used only if fresh, non-degraded, with successful source checks. No extrapolation from a
  24-hour probability to a one-hour horizon. The default confidence threshold is 0.7;
  probabilities are uncalibrated and do not guarantee the account will receive a reset.
- Expiring active-account credits prompt a recovery check before recommending a switch.
  Otherwise prefer a healthy candidate that covers a qualifying forecast horizon, then
  one that can reach scheduled recovery, then greater minimum remaining percentage.

## State and notification contract

`$XDG_STATE_HOME/codex-usage-advisor/state.json` stores hashed account/window keys,
samples and the last emitted recommendation. It contains no tokens, emails or raw
account IDs. Corrupt state fails visibly instead of silently losing deduplication.
The `usage_advice` JSON event contains `advice_id`, `kind`, `summary`, and `description`.
No direct webhook is called. Connect the journal to an existing notification pipeline.
Events are marked emitted after writing stdout, **not after a Discord acknowledgement**.
This is best-effort delivery: a pipeline outage can lose a recommendation until it is
eligible again. Unchanged advice repeats after six hours; changed advice has a minimum
30-minute interval. These are persistent across service restarts.

The emitted account numbers refer to the latest codex-auth snapshot. Check `codex-auth
list` before manually switching; display numbers are not stable IDs. Existing Codex
processes may keep old credentials. Notifications are suggestions for the next work,
not a claim that already-running tasks will migrate.

`codex-usage-advisor --dry-run` reads live accounts and the forecast, prints only
`advisory_preview` / `advisor_checked`, and does not update advisor state. It still
refreshes codex-auth's usage cache. The service never calls reset/switch/login.

Inspect `journalctl --user -u codex-usage-advisor.service`. The normal success event is
`advisor_checked`; failures log `advisor_failed` without raw auth or error payloads.

Forecast source: https://nextreset.ai/forecast/ (unofficial heuristic).

## Observability

Normal polls emit `account_status`, `usage_snapshot`, `credit_snapshot`,
`forecast_snapshot` and `advisor_status` JSON events for every account and valid
forecast horizon. These events do not notify Discord. Account identifiers are
hashed, and account numbers are local to the monitoring host. A selected account
is not proof that an existing client process has reloaded its credentials.

Numeric `-1` means unknown for speed, runway and credit expiry. Apply
`last_over_time` before filtering negative values so an unknown observation
clears an older estimate. Gate quota series with the latest account freshness
and forecast series with the latest forecast validity; expire current values
when no poll has succeeded for 15 minutes. Forecast probabilities are uncalibrated.

The Tibo announcement monitor can feed its journal into the same Loki dashboard.
Its notification timestamp is an observation/delivery time, not confirmation that
an individual account recovered. Keep its public announcement notification and
this private account advice as independent modules; neither needs to control
Codex sessions or change the other monitor's delivery state.

`codex-auth` keeps the previous `updated_at` when values are unchanged. For each
`list --api --json` call, the adapter records its own observation time only when
that account reports `refresh.requested=true`, `method=api`, `status=ok`, and
`source=api`. This both keeps idle accounts fresh and records unchanged samples
needed for consumption estimates. Failed/local/unrequested snapshots retain their
original timestamp and remain excluded as appropriate.
