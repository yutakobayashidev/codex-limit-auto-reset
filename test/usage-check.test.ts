import { expect, it, vi } from "vitest";
import type { ConsumeCredit, RateLimitCredits } from "../src/codex-schemas.ts";
import { createLogger } from "../src/log.ts";
import { checkCredits } from "../src/usage-check.ts";

const now = 1_800_000_000_000;
const hour = 60 * 60 * 1000;
const credit = (id: string, offset: number, status = "available") => ({
  id,
  expiresAt: (now + offset) / 1000,
  grantedAt: (now - hour) / 1000,
  resetType: "codexRateLimits" as const,
  status: status as "available" | "redeemed",
});
const fixture = (credits = [credit("credit-1", hour)]) => {
  const lines: string[] = [];
  const client = {
    refreshAccount: vi.fn(async () => {}),
    readCredits: vi.fn(
      async (): Promise<RateLimitCredits> => ({
        rateLimitResetCredits: { availableCount: credits.length, credits },
      }),
    ),
    consumeCredit: vi.fn(async (_id: string, _key: string): Promise<ConsumeCredit> => ({ outcome: "reset" })),
  };
  const log = createLogger(
    (line) => lines.push(line),
    () => new Date(now),
  );
  return { client, log, lines, events: () => lines.map((line) => JSON.parse(line)) };
};

const usageOptions = () => ({
  remainingPercent: 10,
  pollIntervalSeconds: 60,
  recovery: { pendingCreditId: null as string | null },
  saveRecovery: vi.fn(async () => {}),
});
const withUsage = (f: ReturnType<typeof fixture>, usedPercent: number, secondary?: number) => {
  f.client.readCredits.mockResolvedValue({
    rateLimitResetCredits: { availableCount: 2, credits: [credit("later", 48 * hour), credit("sooner", 24 * hour)] },
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent },
      ...(secondary === undefined ? {} : { secondary: { usedPercent: secondary } }),
    },
  });
};

it.each([
  [90, undefined],
  [10, 99],
  [101, undefined],
])("uses only the earliest credit at low allowance (%s, %s)", async (primary, secondary) => {
  const f = fixture();
  withUsage(f, primary, secondary);
  const options = usageOptions();
  f.client.consumeCredit.mockImplementation(async () => {
    expect(options.recovery.pendingCreditId).toBe("sooner");
    expect(options.saveRecovery).toHaveBeenCalledOnce();
    return { outcome: "reset" };
  });
  expect(await checkCredits(f.client, 360, f.log, () => now, options)).toBe(60_000);
  expect(f.client.consumeCredit.mock.calls).toEqual([["sooner", expect.any(String)]]);
  expect(f.events()).toContainEqual(
    expect.objectContaining({ event: "credit_redemption_result", reason: "low_usage" }),
  );
});

it("does not spend for healthy, missing, elapsed, or model-specific limits", async () => {
  for (const rateLimits of [
    undefined,
    null,
    { primary: { usedPercent: 89 } },
    { limitId: "model-specific", primary: { usedPercent: 100 } },
    { primary: { usedPercent: 100, resetsAt: now / 1000 - 1 } },
  ]) {
    const f = fixture([credit("future", 24 * hour)]);
    f.client.readCredits.mockResolvedValue({
      rateLimitResetCredits: { availableCount: 1, credits: [credit("future", 24 * hour)] },
      ...(rateLimits === undefined ? {} : { rateLimits }),
    });
    await checkCredits(f.client, 360, f.log, () => now, usageOptions());
    expect(f.client.consumeCredit).not.toHaveBeenCalled();
  }
});

it("does not monitor usage unless opted in", async () => {
  const f = fixture();
  withUsage(f, 100);
  await checkCredits(f.client, 360, f.log, () => now);
  expect(f.client.consumeCredit).not.toHaveBeenCalled();
});

it("waits for observed recovery before using a second credit, including after restart", async () => {
  const f = fixture();
  withUsage(f, 100);
  const options = usageOptions();
  await checkCredits(f.client, 360, f.log, () => now, options);
  // The consumed card has disappeared but usage still shows the exhausted window.
  f.client.readCredits.mockResolvedValue({
    rateLimitResetCredits: { availableCount: 1, credits: [credit("later", 48 * hour)] },
    rateLimits: { primary: { usedPercent: 100 } },
  });
  const restored = { ...usageOptions(), recovery: JSON.parse(JSON.stringify(options.recovery)) };
  await checkCredits(f.client, 360, f.log, () => now, restored);
  expect(f.client.consumeCredit).toHaveBeenCalledTimes(1);
  withUsage(f, 1);
  await checkCredits(f.client, 360, f.log, () => now, restored);
  expect(restored.recovery.pendingCreditId).toBeNull();
  withUsage(f, 95);
  await checkCredits(f.client, 360, f.log, () => now, restored);
  expect(f.client.consumeCredit).toHaveBeenCalledTimes(2);
});

it("retries the same pending card after an uncertain failure without selecting another", async () => {
  const f = fixture();
  withUsage(f, 100);
  const options = usageOptions();
  options.recovery.pendingCreditId = "later";
  await checkCredits(f.client, 360, f.log, () => now, options);
  expect(f.client.consumeCredit.mock.calls).toEqual([["later", "later"]]);
});

it("uses at most one card when expiration and usage triggers overlap", async () => {
  const f = fixture([credit("first", hour), credit("second", 2 * hour)]);
  const snapshot = await f.client.readCredits();
  f.client.readCredits.mockResolvedValue({ ...snapshot, rateLimits: { primary: { usedPercent: 100 } } });
  await checkCredits(f.client, 360, f.log, () => now, usageOptions());
  expect(f.client.consumeCredit.mock.calls).toEqual([["first", expect.any(String)]]);
});

it("allows non-expiring cards for low usage but not expiry-only checks", async () => {
  const f = fixture();
  f.client.readCredits.mockResolvedValue({
    rateLimitResetCredits: { availableCount: 1, credits: [{ ...credit("forever", hour), expiresAt: null }] },
    rateLimits: { primary: { usedPercent: 95 } },
  });
  await checkCredits(f.client, 360, f.log, () => now);
  expect(f.client.consumeCredit).not.toHaveBeenCalled();
  await checkCredits(f.client, 360, f.log, () => now, usageOptions());
  expect(f.client.consumeCredit.mock.calls).toEqual([["forever", expect.any(String)]]);
});

it("does not redeem if writing the checkpoint fails", async () => {
  const f = fixture();
  withUsage(f, 100);
  const options = usageOptions();
  options.saveRecovery.mockRejectedValue(new Error("disk full"));
  await expect(checkCredits(f.client, 360, f.log, () => now, options)).rejects.toThrow("disk full");
  expect(f.client.consumeCredit).not.toHaveBeenCalled();
});

it("persists one key for uncertain retries and creates a fresh key after nothingToReset", async () => {
  const f = fixture();
  withUsage(f, 100);
  const options = usageOptions();
  f.client.consumeCredit.mockResolvedValue({ outcome: "nothingToReset" });
  await checkCredits(f.client, 360, f.log, () => now, options);
  await checkCredits(f.client, 360, f.log, () => now, options);
  const calls = f.client.consumeCredit.mock.calls;
  expect(calls[0]?.[1]).not.toBe(calls[1]?.[1]);
  f.client.consumeCredit.mockResolvedValue({ outcome: "reset" });
  await checkCredits(f.client, 360, f.log, () => now, options);
  const restored = { ...options, recovery: JSON.parse(JSON.stringify(options.recovery)) };
  await checkCredits(f.client, 360, f.log, () => now, restored);
  expect(calls[2]?.[1]).toBe(calls[3]?.[1]);
});
