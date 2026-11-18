# codex-limit-auto-reset

A small tool that monitors Codex rate-limit reset credits and automatically redeems them before they expire.

## Run locally

Requires Node.js 24 or later, pnpm, and an authenticated [Codex CLI](https://github.com/openai/codex).

```sh
pnpm install
pnpm start
```

To list the available credits without redeeming them:

```sh
pnpm start:cli
```

To redeem the credit that expires first right now, after a confirmation prompt:

```sh
pnpm start:reset
```

## Run with Docker

Mount your Codex CLI credentials into the container:

```sh
docker run -d \
  --name codex-limit-auto-reset \
  --restart unless-stopped \
  -v "$HOME/.codex:/data/codex" \
  ghcr.io/fa0311/codex-limit-auto-reset
```

The worker exits with status 1 when a check fails, so keep a restart policy on
the container. The same commands are available inside it:

```sh
docker exec codex-limit-auto-reset node dist/cli.js
docker exec -it codex-limit-auto-reset node dist/reset.js
```

## How credits are redeemed

A credit becomes due `REDEEM_BEFORE_MINUTES` before it expires. At each check
the worker redeems the due credit that expires first:

- `reset`: the usage is reset, and the check ends. A second due credit would
  find nothing left to reset, so it waits for a later check.
- `nothingToReset`: the usage does not need a reset right now, and the credit is
  kept. The worker tries again after half of the time the credit has left (at
  most once a minute), so the attempts close in on the expiry.
- `noCredit` or `alreadyRedeemed`: the credit is gone, and the worker moves on to
  the next due credit.

Between checks the worker sleeps until the next credit becomes due, and wakes at
least once a day to pick up newly granted credits. Credits that never expire are
left alone.

app-server can report only how many credits are available, without their
expiry times. The worker then logs `credit_details_unavailable` and asks again
ten minutes later instead of waiting for the daily scan.

## Configuration

The following environment variables are available:

| Variable | Default | Description |
| --- | --- | --- |
| `REDEEM_BEFORE_MINUTES` | `360` | How many minutes before expiration a credit should be redeemed |
| `RESET_REMAINING_PERCENT` | unset | Opt in to resetting when either main allowance has this percentage or less remaining (0–20) |
| `USAGE_POLL_SECONDS` | `60` | Poll interval with usage monitoring enabled (10–3600 seconds) |
| `STATE_FILE` | `$XDG_STATE_HOME/codex-limit-auto-reset/recovery.json` | Persistent pending-redemption checkpoint; XDG state defaults to `~/.local/state` |
| `CODEX_BIN` | `codex` | Codex CLI command or path |
| `LOCAL` | `en` | Locale for the dates printed by `start:cli` and `start:reset` |
| `TIMEZONE` | `UTC` | Time zone for those dates |

Local runs also load variables from a `.env` file in the project root.

## Low-usage resets

Set `RESET_REMAINING_PERCENT=10` to check the main Codex allowance every 60 seconds
and redeem when its primary or secondary window has 10% or less remaining.
Expiry-based redemption remains enabled. With usage monitoring enabled, both triggers select at most one available,
unexpired credit per check, earliest expiry first. Credits without an expiration
can be used for low usage, after dated credits, but never for the expiry trigger.
Model-specific allowances and elapsed usage windows do not trigger a full reset.
Missing usage data never triggers a low-usage redemption.

Usage monitoring is opt-in; leaving the threshold unset retains expiry scheduling.
This worker changes the account's allowance, regardless of which client consumes it.
It does not resume tasks that already stopped. A sudden burst can exhaust usage
between polls, so choose a threshold with sufficient headroom.

Run only one worker per account, including across machines. Before a monitored
redemption, the worker atomically saves the selected credit ID. Subsequent checks
retry that same ID (using its idempotency key) if it is still available; otherwise
they wait until the main allowance is observed above the threshold before allowing
another redemption. This survives restarts and avoids spending the next credit
on stale usage. A corrupt checkpoint stops the worker instead of losing this guard.
Use separate state files for separate accounts. If recovery stays pending, inspect
usage and the redemption history before manually clearing the checkpoint; do not
remove it merely to force another reset. Unknown RPC failures retain the checkpoint;
explicit `nothingToReset` and `noCredit` responses clear it for the next check.

## Reset history

The background worker writes one JSON object per line to standard output. Each
record includes an ISO 8601 UTC `timestamp`, `level`, and `event`:

```json
{"timestamp":"2026-11-01T01:23:45.000Z","level":"info","event":"credit_redemption_result","credit_id":"example-credit","attempt":1,"outcome":"reset"}
```

Events:

- `credit_redemption_attempt`: `credit_id` and one-based `attempt` before each RPC attempt.
- `credit_redemption_result`: `credit_id`, `attempt`, and the returned `outcome`.
- `credit_redemption_error`: `credit_id`, `attempt`, and the failure for each failed RPC attempt.
- `check_failed`: `operation` (`initialize` or `check`) and the failure when the worker terminates unsuccessfully.
- `credit_details_unavailable`: `available_count` when app-server reported credits without their expiry times.
- `next_check`: `delay_ms` until the next scheduled scan, including the daily scan when no credits are eligible.

Count **only** `credit_redemption_result` with `outcome: "reset"` as confirmed
resets. `nothingToReset`, `noCredit`, and `alreadyRedeemed` are separate results;
failed attempts are not resets. Each redemption attempt has its own idempotency
key (a UUID), which only the retries of that attempt reuse. If a reset succeeds
remotely but its response is lost, a later `alreadyRedeemed` response cannot
prove that this worker performed the reset; it is not counted as one. Logs
report observed outcomes, not a transactional audit trail.

A failure is an `error_type`, plus a one-line `detail` when the worker
recognises the problem:

| `error_type` | Meaning |
| --- | --- |
| `not_authenticated` | Codex is logged out, or not logged in with ChatGPT. Run `codex login`. |
| `invalid_config` | An environment variable is invalid; `detail` names it. |
| `rpc_error` | app-server answered a request with an error; `detail` has the method, code, and message. |
| `request_timeout` | app-server did not answer within 30 seconds. |
| `app_server_exited` | The Codex CLI could not be started, or it exited. |
| `invalid_response` | app-server answered in a shape this version does not understand; `detail` names the field. |
| `operation_failed` | Anything else. There is no `detail`. |

A failed request is tried three times, 2 and 8 seconds apart, unless it cannot
succeed (logged out, or a request app-server rejects as invalid).

`detail` is text the worker composes itself, plus app-server's own error
message for `rpc_error`. Raw exceptions, stacks, and RPC payloads are never
logged, since they may contain authentication data, which is why an error the
worker does not recognise has no `detail`. Codex app-server's own diagnostic
stderr remains separate from the worker's JSON stdout. The interactive CLI
commands retain their human-readable output.



For systemd, the journal captures these records. A collector such as Alloy can
forward them to Loki; the worker does not require a metrics server or a webhook.
Use your desired local timezone when grouping UTC timestamps into calendar days.
Log retention and durable storage are the responsibility of the journal/collector.

## Development

```sh
pnpm check
pnpm build
```

`pnpm check` runs the type check, Biome, and the tests. The tests never talk to
Codex: the end-to-end ones start the real entry points against
`test/fixtures/fake-codex.mjs`, a scripted stand-in for `codex app-server`, so
no credit is spent. The same stand-in is handy for trying a change by hand:

```sh
CODEX_BIN=test/fixtures/fake-codex.mjs \
FAKE_CODEX_SCENARIO='{"credits":{"availableCount":0,"credits":[]}}' \
node src/main.ts
```

## License

[MIT](./LICENSE)

## Nix

The flake provides a package, worker and read-only credits apps, and a development
shell for x86_64/aarch64 Linux and macOS:

```sh
nix build
nix run .#credits
nix run
nix develop
```

An authenticated Codex CLI must be on `PATH`, or specified with `CODEX_BIN`.
The package uses your existing Codex installation and credentials. Environment
variables such as `CODEX_HOME` and `REDEEM_BEFORE_MINUTES` are passed through;
unlike `pnpm start`, the packaged executables do not load a local `.env` file.

From another flake, use `inputs.codex-limit-auto-reset.packages.${system}.default`
with the input URL `github:fa0311/codex-limit-auto-reset`. The package installs
`codex-limit-auto-reset` and `codex-limit-auto-reset-cli`, which can also be used
in a Home Manager or systemd service. `nix flake check` builds the package for
the current system.

### Home Manager (Linux)

Import `inputs.codex-limit-auto-reset.homeManagerModules.default` and enable:

```nix
services.codex-limit-auto-reset = {
  enable = true;
  redeemBeforeMinutes = 360;
  resetRemainingPercent = 3; # null (default) disables usage monitoring
  usagePollSeconds = 60;
  # codexPackage = pkgs.codex;
  # codexHome = "${config.home.homeDirectory}/.codex";
};
```

This starts a systemd user service and restarts it on failure. `codexPackage`
defaults to the package configured by `programs.codex` when enabled, otherwise
`pkgs.codex`; `codexHome` respects `home.sessionVariables.CODEX_HOME`.
Authenticate with that Codex installation before enabling the service. Use
`journalctl --user -u codex-limit-auto-reset` to inspect the worker.
The package and Home Manager module are maintained here rather than requiring NUR.
# Optional account advisor

The personal fork also provides a Linux-only, advisory-only account monitor.
It compares all codex-auth accounts and a Tibo reset forecast, emitting recommendations
without switching accounts or consuming credits. See [usage advisor](docs/usage-advisor.md).

