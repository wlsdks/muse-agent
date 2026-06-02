import { describe, expect, it } from "vitest";

import { resolveRelativeTimePhrase } from "../src/loopback-relative-time.js";

// Reference: Wednesday 2026-06-03 09:30 UTC. Assertions are timezone-robust
// (day counts / local getHours / KO-equals-EN), never a hard-coded ISO.
const now = (): Date => new Date("2026-06-03T09:30:00Z");

describe("resolveRelativeTimePhrase — period phrases (next week/month/year + KO parity)", () => {
  it("resolves next week / month / year (EN) to future dates", () => {
    for (const phrase of ["next week", "next month", "next year"]) {
      const resolved = resolveRelativeTimePhrase(phrase, now);
      expect(resolved, phrase).toBeDefined();
      expect(resolved!.getTime(), phrase).toBeGreaterThan(now().getTime());
    }
  });

  it("'next week' lands about 7 days out", () => {
    const days = (resolveRelativeTimePhrase("next week", now)!.getTime() - now().getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThan(8);
  });

  it("'next year' lands about a year out", () => {
    const days = (resolveRelativeTimePhrase("next year", now)!.getTime() - now().getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });

  it("KO 다음 주 / 다음 달 / 내년 match their English counterparts exactly", () => {
    expect(resolveRelativeTimePhrase("다음 주", now)?.toISOString()).toBe(resolveRelativeTimePhrase("next week", now)?.toISOString());
    expect(resolveRelativeTimePhrase("다음 달", now)?.toISOString()).toBe(resolveRelativeTimePhrase("next month", now)?.toISOString());
    expect(resolveRelativeTimePhrase("내년", now)?.toISOString()).toBe(resolveRelativeTimePhrase("next year", now)?.toISOString());
  });

  it("'next month at 2pm' parses the time of day", () => {
    expect(resolveRelativeTimePhrase("next month at 2pm", now)!.getHours()).toBe(14);
  });

  it("does NOT break weekday 'next monday' (still resolves to a Monday)", () => {
    expect(resolveRelativeTimePhrase("next monday", now)!.getDay()).toBe(1);
  });

  it("does NOT match a non-period 'next <noun>' — precision over a bare weekday slot", () => {
    expect(resolveRelativeTimePhrase("next mango", now)).toBeUndefined();
    expect(resolveRelativeTimePhrase("next thing", now)).toBeUndefined();
  });

  it("'this weekend' / 'next weekend' land on a Saturday, a week apart", () => {
    const thisW = resolveRelativeTimePhrase("this weekend", now)!;
    const nextW = resolveRelativeTimePhrase("next weekend", now)!;
    expect(thisW.getDay()).toBe(6);
    expect(nextW.getDay()).toBe(6);
    expect(Math.round((nextW.getTime() - thisW.getTime()) / 86_400_000)).toBe(7);
    // reference is Wednesday → this Saturday is the 6th
    expect(thisW.getDate()).toBe(6);
  });

  it("'end of the month' / 'end of month' land on the last day of June (30th)", () => {
    for (const phrase of ["end of the month", "end of month", "end of this month"]) {
      const r = resolveRelativeTimePhrase(phrase, now)!;
      expect(r, phrase).toBeDefined();
      expect(r.getDate(), phrase).toBe(30);
      expect(r.getMonth(), phrase).toBe(5); // June (0-indexed)
    }
  });

  it("'this weekend at 8am' parses the time of day", () => {
    expect(resolveRelativeTimePhrase("this weekend at 8am", now)!.getHours()).toBe(8);
  });

  it("KO 이번 주말 / 다음 주말 / 월말 / 이달 말 match their English counterparts", () => {
    expect(resolveRelativeTimePhrase("이번 주말", now)?.toISOString()).toBe(resolveRelativeTimePhrase("this weekend", now)?.toISOString());
    expect(resolveRelativeTimePhrase("다음 주말", now)?.toISOString()).toBe(resolveRelativeTimePhrase("next weekend", now)?.toISOString());
    expect(resolveRelativeTimePhrase("월말", now)?.toISOString()).toBe(resolveRelativeTimePhrase("end of month", now)?.toISOString());
    expect(resolveRelativeTimePhrase("이달 말", now)?.toISOString()).toBe(resolveRelativeTimePhrase("end of month", now)?.toISOString());
  });
});
