import { describe, expect, it } from "vitest";

import { isRecentProactiveActivity, selectProactiveSink } from "../src/index.js";

describe("isRecentProactiveActivity", () => {
  it.each([
    [700, undefined, true],
    [700, 300, true],
    [699, 300, false],
    [1_001, 300, false],
    [-1, 300, false],
    [Number.NaN, 300, false],
    [Number.POSITIVE_INFINITY, 300, false],
    [700, -1, false],
    [700, Number.NaN, false],
    [700, Number.POSITIVE_INFINITY, false]
  ] as const)("classifies last=%s window=%s with an inclusive valid age", (lastMs, windowMs, expected) => {
    expect(isRecentProactiveActivity(lastMs, 1_000, windowMs)).toBe(expected);
  });

  it("fails closed for missing activity and an invalid current clock", () => {
    expect(isRecentProactiveActivity(undefined, 1_000, 300)).toBe(false);
    expect(isRecentProactiveActivity(700, Number.NaN, 300)).toBe(false);
  });
});

describe("selectProactiveSink", () => {
  it.each([
    [700, 300, "terminal"],
    [699, 300, "messaging"],
    [1_001, 300, "messaging"],
    [-1, 300, "messaging"],
    [Number.NaN, 300, "messaging"],
    [700, -1, "messaging"],
    [700, Number.NaN, "messaging"]
  ] as const)("routes last=%s window=%s to %s", (lastMs, maxAgeMs, expected) => {
    expect(selectProactiveSink(
      { lastActivityMs: () => lastMs },
      true,
      { maxAgeMs, nowMs: 1_000 }
    )).toBe(expected);
  });

  it("falls back to messaging when the terminal or presence source is absent", () => {
    expect(selectProactiveSink({ lastActivityMs: () => 1_000 }, false)).toBe("messaging");
    expect(selectProactiveSink(undefined, true)).toBe("messaging");
    expect(selectProactiveSink({ lastActivityMs: () => Date.now() + 60_000 }, true)).toBe("messaging");
  });
});
