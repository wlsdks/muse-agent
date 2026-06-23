import { describe, expect, it } from "vitest";

import { computeDecorrelatedRetryDelay, retry } from "../src/index.js";

describe("computeDecorrelatedRetryDelay", () => {
  const opts = { initialDelayMs: 100, maxDelayMs: 10_000 };

  it("draws from [initial, prev*3] using the injected random", () => {
    // random=0 → lower bound (initial)
    expect(computeDecorrelatedRetryDelay(100, { ...opts, random: () => 0 })).toBe(100);
    // random=1 → upper bound = min(maxDelay, prev*3) = 300 for prev=100
    expect(computeDecorrelatedRetryDelay(100, { ...opts, random: () => 1 })).toBe(300);
    // prev grows the window: prev=1000 → upper = 3000; random=0.5 → 100 + 0.5*(3000-100)=1550
    expect(computeDecorrelatedRetryDelay(1000, { ...opts, random: () => 0.5 })).toBe(1550);
  });

  it("caps the upper bound at maxDelayMs", () => {
    // prev*3 = 30_000 but cap is 10_000 → random=1 yields the cap
    expect(computeDecorrelatedRetryDelay(10_000, { ...opts, random: () => 1 })).toBe(10_000);
  });

  it("never returns below initial, even with a tiny/invalid prev", () => {
    expect(computeDecorrelatedRetryDelay(0, { ...opts, random: () => 0 })).toBe(100);
    expect(computeDecorrelatedRetryDelay(Number.NaN, { ...opts, random: () => 0 })).toBe(100);
  });
});

describe("retry with jitter: 'decorrelated'", () => {
  it("uses decorrelated delays (carried forward) for the backoff sleeps", async () => {
    const waits: number[] = [];
    const rng = () => 1; // always upper bound → deterministic growth
    const op = () => Promise.reject(new Error("transient"));
    await expect(
      retry(op, {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 100_000,
        jitter: "decorrelated",
        random: rng,
        sleep: async (ms) => { waits.push(ms); }
      })
    ).rejects.toBeDefined();
    // attempt1: prev=100 → upper 300 → 300; attempt2: prev=300 → upper 900 → 900
    expect(waits).toEqual([300, 900]);
  });
});
