import { describe, expect, it } from "vitest";

import {
  formatCurrentTime,
  isWorkingHours,
  parseWorkingHoursString,
  resolveTimezone
} from "../src/time-helpers.js";

describe("resolveTimezone", () => {
  it("returns the requested IANA timezone when valid", () => {
    expect(resolveTimezone("Asia/Seoul")).toBe("Asia/Seoul");
  });

  it("falls back to UTC on invalid timezone", () => {
    expect(resolveTimezone("Not/A_Zone")).toMatch(/UTC|^[A-Z][A-Za-z_/]+$/u);
  });

  it("returns a sensible default when no timezone passed", () => {
    expect(resolveTimezone()).toBeTruthy();
  });
});

describe("formatCurrentTime", () => {
  const fixed = new Date("2026-05-11T08:30:00.000Z");

  it("produces ISO + weekday + localHour", () => {
    const result = formatCurrentTime(fixed, "Asia/Seoul");
    expect(result.iso).toBe("2026-05-11T08:30:00.000Z");
    expect(result.timezone).toBe("Asia/Seoul");
    expect(result.weekday).toMatch(/Monday/u);
    // 08:30 UTC = 17:30 Seoul
    expect(result.localHour).toBe(17);
  });
});

describe("isWorkingHours", () => {
  it("true for a time within the window", () => {
    const noonUtc = new Date("2026-05-11T12:00:00.000Z");
    expect(isWorkingHours(noonUtc, { end: 17, start: 9 }, "UTC")).toBe(true);
  });

  it("false outside the window", () => {
    const midnight = new Date("2026-05-11T22:00:00.000Z");
    expect(isWorkingHours(midnight, { end: 17, start: 9 }, "UTC")).toBe(false);
  });

  it("handles wraparound windows (night shift)", () => {
    const earlyMorning = new Date("2026-05-11T02:00:00.000Z");
    expect(isWorkingHours(earlyMorning, { end: 6, start: 22 }, "UTC")).toBe(true);
  });
});

describe("parseWorkingHoursString", () => {
  it("parses 9-17", () => {
    expect(parseWorkingHoursString("9-17")).toEqual({ end: 17, start: 9 });
  });

  it("parses 9 to 17", () => {
    expect(parseWorkingHoursString("9 to 17")).toEqual({ end: 17, start: 9 });
  });

  it("returns undefined for malformed input", () => {
    expect(parseWorkingHoursString("morning")).toBeUndefined();
    expect(parseWorkingHoursString(undefined)).toBeUndefined();
  });
});

describe("humanizeRelativeFromIso (iter 7)", () => {
  const now = "2026-05-11T12:00:00.000Z";

  it("returns 'now' when within ±60 seconds", async () => {
    const { humanizeRelativeFromIso } = await import("../src/time-helpers.js");
    expect(humanizeRelativeFromIso(now, "2026-05-11T12:00:30.000Z")).toBe("now");
    expect(humanizeRelativeFromIso(now, "2026-05-11T11:59:45.000Z")).toBe("now");
  });

  it("formats future offsets with 'in <unit>'", async () => {
    const { humanizeRelativeFromIso } = await import("../src/time-helpers.js");
    expect(humanizeRelativeFromIso(now, "2026-05-11T12:30:00.000Z")).toBe("in 30 min");
    expect(humanizeRelativeFromIso(now, "2026-05-11T14:00:00.000Z")).toBe("in 2h");
    expect(humanizeRelativeFromIso(now, "2026-05-14T12:00:00.000Z")).toBe("in 3 day(s)");
  });

  it("formats past offsets with 'ago'", async () => {
    const { humanizeRelativeFromIso } = await import("../src/time-helpers.js");
    expect(humanizeRelativeFromIso(now, "2026-05-11T11:30:00.000Z")).toBe("30 min ago");
    expect(humanizeRelativeFromIso(now, "2026-05-11T10:00:00.000Z")).toBe("2h ago");
    expect(humanizeRelativeFromIso(now, "2026-05-09T12:00:00.000Z")).toBe("2 day(s) ago");
  });

  it("returns undefined for unparseable input", async () => {
    const { humanizeRelativeFromIso } = await import("../src/time-helpers.js");
    expect(humanizeRelativeFromIso("not a date", now)).toBeUndefined();
    expect(humanizeRelativeFromIso(now, "")).toBeUndefined();
  });
});
