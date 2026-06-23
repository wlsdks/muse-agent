import { describe, expect, it } from "vitest";

import { scaleRequestTimeout } from "../src/index.js";

describe("scaleRequestTimeout", () => {
  it("keeps the base timeout for a small request", () => {
    // 1000 tokens * 4ms = 4000 < 120000 base → base wins.
    expect(scaleRequestTimeout(120_000, 1_000)).toBe(120_000);
  });

  it("scales up for a large request (base * estimate)", () => {
    // 50_000 tokens * 4ms = 200_000 > 120_000 base.
    expect(scaleRequestTimeout(120_000, 50_000)).toBe(200_000);
  });

  it("caps at the max timeout", () => {
    // 1_000_000 tokens * 4ms = 4_000_000 → capped at 600_000 default.
    expect(scaleRequestTimeout(120_000, 1_000_000)).toBe(600_000);
  });

  it("respects custom msPerToken and maxTimeoutMs", () => {
    expect(scaleRequestTimeout(10_000, 5_000, { msPerToken: 10 })).toBe(50_000);
    expect(scaleRequestTimeout(10_000, 5_000, { msPerToken: 10, maxTimeoutMs: 30_000 })).toBe(30_000);
  });

  it("never returns below the base, even with zero/invalid token estimates", () => {
    expect(scaleRequestTimeout(120_000, 0)).toBe(120_000);
    expect(scaleRequestTimeout(120_000, Number.NaN)).toBe(120_000);
    expect(scaleRequestTimeout(120_000, -5)).toBe(120_000);
  });

  it("passes a non-positive base through untouched (no-timeout convention)", () => {
    expect(scaleRequestTimeout(0, 50_000)).toBe(0);
    expect(scaleRequestTimeout(-1, 50_000)).toBe(-1);
  });
});
