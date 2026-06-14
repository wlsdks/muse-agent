import { describe, expect, it } from "vitest";

import { addCalendarMonths, DEFAULT_HOUR, startOfDay } from "../src/loopback-relative-time-base.js";
import { resolveKoreanRelativePhrase } from "../src/loopback-relative-time-korean.js";

describe("loopback-relative-time-base", () => {
  it("addCalendarMonths clamps a day overflow back to the intended month's last day", () => {
    const got = addCalendarMonths(new Date(2026, 0, 31), 1); // Jan 31 + 1mo → Feb (no 31st)
    expect(got.getMonth()).toBe(1); // February, not March 3
    expect(got.getDate()).toBe(28); // 2026 is not a leap year
  });

  it("addCalendarMonths handles a normal month step and year rollover", () => {
    expect(addCalendarMonths(new Date(2026, 2, 15), 2).getMonth()).toBe(4); // Mar → May
    expect(addCalendarMonths(new Date(2026, 11, 10), 1).getFullYear()).toBe(2027); // Dec → next Jan
  });

  it("startOfDay zeroes the wall-clock time but keeps the calendar day", () => {
    const got = startOfDay(new Date(2026, 5, 15, 14, 30, 45, 123));
    expect(got.getHours()).toBe(0);
    expect(got.getMinutes()).toBe(0);
    expect(got.getSeconds()).toBe(0);
    expect(got.getDate()).toBe(15);
  });
});

describe("resolveKoreanRelativePhrase (moved into the korean module)", () => {
  const ref = new Date(2026, 5, 15, 10, 0); // 2026-06-15 10:00 local

  it("resolves a bare day phrase to the next day at the default hour", () => {
    const got = resolveKoreanRelativePhrase("내일", ref);
    expect(got).toBeDefined();
    expect(got!.getDate()).toBe(16);
    expect(got!.getHours()).toBe(DEFAULT_HOUR);
  });

  it("resolves a relative-offset phrase ('3일 뒤')", () => {
    const got = resolveKoreanRelativePhrase("3일 뒤", ref);
    expect(got).toBeDefined();
    expect(got!.getDate()).toBe(18);
  });

  it("returns undefined for a non-Korean phrase (caller falls through to English)", () => {
    expect(resolveKoreanRelativePhrase("tomorrow at noon", ref)).toBeUndefined();
    expect(resolveKoreanRelativePhrase("", ref)).toBeUndefined();
  });
});
