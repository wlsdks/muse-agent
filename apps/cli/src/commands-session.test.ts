import { describe, expect, it } from "vitest";

import { formatRemainingDuration, resolveLockUntilMs } from "./commands-session.js";

describe("formatRemainingDuration", () => {
  it("clamps sub-minute / invalid values to '<1 min'", () => {
    expect(formatRemainingDuration(0)).toBe("<1 min");
    expect(formatRemainingDuration(0.4)).toBe("<1 min");
    expect(formatRemainingDuration(Number.NaN)).toBe("<1 min");
  });
  it("renders whole minutes under an hour", () => {
    expect(formatRemainingDuration(45)).toBe("45 min");
  });
  it("renders whole hours without minutes", () => {
    expect(formatRemainingDuration(120)).toBe("2h");
  });
  it("renders hours and minutes", () => {
    expect(formatRemainingDuration(150)).toBe("2h 30m");
  });
});

describe("resolveLockUntilMs", () => {
  const now = 1_000_000;
  it("defaults to a 1-hour lock when nothing is passed", () => {
    expect(resolveLockUntilMs(undefined, undefined, now)).toBe(now + 60 * 60 * 1000);
  });
  it("adds hours + minutes", () => {
    expect(resolveLockUntilMs("2", "30", now)).toBe(now + (2 * 60 * 60 + 30 * 60) * 1000);
  });
  it("rejects a unit-slip like '4h' (strict Number, not parseFloat)", () => {
    expect(() => resolveLockUntilMs("4h", undefined, now)).toThrow(/numeric/);
  });
  it("rejects negative durations", () => {
    expect(() => resolveLockUntilMs("-1", undefined, now)).toThrow(/non-negative/);
  });
});
