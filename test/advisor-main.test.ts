import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";

it("only lists all accounts, persists deduplication, and keeps dry-run out of the notification stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "advisor-test-"));
  try {
    const now = Date.now() / 1000;
    const fixture = {
      schema_version: 1,
      accounts: [true, false].map((active, i) => ({
        account_key: `private-account-${i}`,
        email: `private-${i}@example.com`,
        number: i + 1,
        active,
        usage: {
          source: "api",
          updated_at: now,
          primary: { used_percent: active ? 95 : 10, window_minutes: 10080, resets_at: now + 86400 },
          secondary: null,
          reset_credit: [],
          refresh: { status: "ok" },
        },
      })),
    };
    const auth = join(dir, "codex-auth");
    const calls = join(dir, "calls");
    await writeFile(
      auth,
      `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log(${JSON.stringify(JSON.stringify(fixture))});\n`,
      { mode: 0o700 },
    );
    const preload = join(dir, "fetch.mjs");
    await writeFile(preload, "globalThis.fetch=async()=>{throw new Error('forecast offline')};\n");
    const state = join(dir, "state.json");
    const env = { ...process.env, CODEX_AUTH_BIN: auth, ADVISOR_STATE_FILE: state };
    const run = (...args: string[]) =>
      execa(process.execPath, ["--import", preload, resolve("src/advisor-main.ts"), ...args], { env, reject: false });
    const first = await run("--lock-held");
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout.split("\n").at(-1) ?? "{}").event).toBe("usage_advice");
    expect(first.stdout).not.toContain("private-");
    const saved = await readFile(state, "utf8");
    expect(saved).not.toContain("private-");
    const second = await run("--lock-held");
    expect(JSON.parse(second.stdout.split("\n").at(-1) ?? "{}").event).toBe("advisor_checked");
    const before = await readFile(state, "utf8");
    const preview = await run("--dry-run");
    expect(JSON.parse(preview.stdout).event).toBe("advisory_preview");
    expect(await readFile(state, "utf8")).toBe(before);
    expect(
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s)),
    ).toEqual(Array(3).fill(["list", "--api", "--json"]));
    await writeFile(state, "invalid private-state-content");
    const bad = await run("--lock-held");
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).not.toContain("private-state-content");
    expect(JSON.parse(bad.stdout).event).toBe("advisor_failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
