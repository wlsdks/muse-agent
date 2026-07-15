import { describe, expect, it } from "vitest";

import { DEFAULT_DAILY_BRIEF_TIME, parseDailyBriefTime, shouldFireDailyBrief } from "./daily-brief.js";

describe("parseDailyBriefTime — strict 24-hour HH:MM (fail-closed)", () => {
  it("parses a zero-padded HH:MM", () => {
    expect(parseDailyBriefTime("08:30")).toEqual({ hour: 8, minute: 30 });
    expect(parseDailyBriefTime("00:00")).toEqual({ hour: 0, minute: 0 });
    expect(parseDailyBriefTime("23:59")).toEqual({ hour: 23, minute: 59 });
  });

  it("trims surrounding whitespace", () => {
    expect(parseDailyBriefTime("  09:05  ")).toEqual({ hour: 9, minute: 5 });
  });

  it("rejects an out-of-range hour ('25:00')", () => {
    expect(() => parseDailyBriefTime("25:00")).toThrow(/HH:MM/);
  });

  it("rejects a 12-hour form ('9am')", () => {
    expect(() => parseDailyBriefTime("9am")).toThrow(/HH:MM/);
  });

  it("rejects an unpadded hour ('9:30') — HH:MM only, no cadence NL", () => {
    expect(() => parseDailyBriefTime("9:30")).toThrow(/HH:MM/);
  });

  it("rejects an out-of-range minute ('08:60')", () => {
    expect(() => parseDailyBriefTime("08:60")).toThrow(/HH:MM/);
  });

  it("names the accepted format in the error", () => {
    expect(() => parseDailyBriefTime("garbage")).toThrow(/08:30/);
  });

  it("DEFAULT_DAILY_BRIEF_TIME itself parses", () => {
    expect(() => parseDailyBriefTime(DEFAULT_DAILY_BRIEF_TIME)).not.toThrow();
  });
});

describe("shouldFireDailyBrief — once-a-day, restart-safe gate (pure)", () => {
  it("does not fire before the target local time", () => {
    expect(shouldFireDailyBrief(new Date("2026-06-04T08:00:00"), undefined, 8, 30)).toBe(false);
  });

  it("fires once past the target time when never fired before", () => {
    expect(shouldFireDailyBrief(new Date("2026-06-04T08:30:00"), undefined, 8, 30)).toBe(true);
    expect(shouldFireDailyBrief(new Date("2026-06-04T09:15:00"), undefined, 8, 30)).toBe(true);
  });

  it("does not double-fire the same local day after already-fired", () => {
    expect(shouldFireDailyBrief(new Date("2026-06-04T09:15:00"), "2026-06-04T08:31:00", 8, 30)).toBe(false);
  });

  it("fires again the next day even though it fired yesterday (no back-fill of missed days)", () => {
    expect(shouldFireDailyBrief(new Date("2026-06-05T08:35:00"), "2026-06-04T08:31:00", 8, 30)).toBe(true);
  });

  it("a daemon that was off past the target time fires on its next tick, same day", () => {
    // Simulates: daemon starts at 14:00, never fired today yet.
    expect(shouldFireDailyBrief(new Date("2026-06-04T14:00:00"), undefined, 8, 30)).toBe(true);
  });

  it("a garbage last-fired timestamp counts as never-fired (fires)", () => {
    expect(shouldFireDailyBrief(new Date("2026-06-04T09:00:00"), "not-a-date", 8, 30)).toBe(true);
  });
});
