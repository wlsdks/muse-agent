import { describe, expect, it } from "vitest";

import { countdownDays, detectCountdownQuery, formatCountdown } from "./countdown-query.js";

describe("detectCountdownQuery — extract the unit + target from a countdown question", () => {
  it("parses the common phrasings, defaulting to days", () => {
    expect(detectCountdownQuery("how many days until June 20?")).toEqual({ ko: false, targetPhrase: "june 20", unit: "days" });
    expect(detectCountdownQuery("how many weeks until March 1")).toEqual({ ko: false, targetPhrase: "march 1", unit: "weeks" });
    expect(detectCountdownQuery("how long until next Friday")).toEqual({ ko: false, targetPhrase: "next friday", unit: "days" });
    expect(detectCountdownQuery("days until 2026-12-25")).toEqual({ ko: false, targetPhrase: "2026-12-25", unit: "days" });
    expect(detectCountdownQuery("countdown to my birthday")).toEqual({ ko: false, targetPhrase: "birthday", unit: "days" });
  });

  it("resolves a named holiday to a parseable date", () => {
    expect(detectCountdownQuery("how many days until Christmas?")).toEqual({ ko: false, targetPhrase: "December 25", unit: "days" });
    expect(detectCountdownQuery("how long until Halloween")).toEqual({ ko: false, targetPhrase: "October 31", unit: "days" });
    expect(detectCountdownQuery("days until New Year's Eve")).toEqual({ ko: false, targetPhrase: "December 31", unit: "days" });
  });

  it("parses a Korean countdown ('<target>까지 며칠/몇 주'), normalizing holidays + month-day to a parseable target", () => {
    expect(detectCountdownQuery("크리스마스까지 며칠 남았어?")).toEqual({ ko: true, targetPhrase: "December 25", unit: "days" });
    expect(detectCountdownQuery("12월 25일까지 며칠 남았어?")).toEqual({ ko: true, targetPhrase: "December 25", unit: "days" });
    expect(detectCountdownQuery("크리스마스까지 몇 주 남았어?")).toEqual({ ko: true, targetPhrase: "December 25", unit: "weeks" });
    expect(detectCountdownQuery("10월 1일까지 며칠")).toEqual({ ko: true, targetPhrase: "October 1", unit: "days" });
  });

  it("returns null for a non-countdown question (recall is never hijacked)", () => {
    expect(detectCountdownQuery("what's the date next Friday?")).toBeNull();
    expect(detectCountdownQuery("how many people are coming?")).toBeNull();    // "many" but no until/till
    expect(detectCountdownQuery("how many days are in a week?")).toBeNull();   // "in", not "until"
    expect(detectCountdownQuery("summarize the launch plan")).toBeNull();
  });
});

describe("countdownDays — exact whole-day count, where the 8B miscounts", () => {
  const now = new Date("2026-06-05T12:00:00"); // local Friday, June 5
  it("counts across months and year boundaries correctly", () => {
    expect(countdownDays(now, "2026-12-25T00:00:00.000Z")).toBe(203); // Christmas — 8B said 198
    expect(countdownDays(now, "2027-03-01T00:00:00.000Z")).toBe(269); // next March 1 — 8B said 245
    expect(countdownDays(now, "2027-01-01T00:00:00.000Z")).toBe(210); // New Year — 8B said 189
    expect(countdownDays(now, "2026-06-20T00:00:00.000Z")).toBe(15);
    expect(countdownDays(now, "2026-06-05T00:00:00.000Z")).toBe(0);   // today
  });
});

describe("formatCountdown — readable, pluralised, UTC-stable date", () => {
  it("frames days / weeks / today, with the resolved date", () => {
    expect(formatCountdown("days", 203, "2026-12-25T00:00:00.000Z")).toBe("There are 203 days until Friday, December 25, 2026.");
    expect(formatCountdown("days", 1, "2026-06-06T00:00:00.000Z")).toBe("There is 1 day until Saturday, June 6, 2026.");
    expect(formatCountdown("weeks", 203, "2026-12-25T00:00:00.000Z")).toBe("There are about 29 weeks until Friday, December 25, 2026.");
    expect(formatCountdown("days", 0, "2026-06-05T00:00:00.000Z")).toBe("Friday, June 5, 2026 is today!");
  });

  it("frames a Korean countdown in Korean when ko=true", () => {
    expect(formatCountdown("days", 201, "2026-12-25T00:00:00.000Z", true)).toBe("2026년 12월 25일 금요일까지 201일 남았습니다.");
    expect(formatCountdown("weeks", 201, "2026-12-25T00:00:00.000Z", true)).toBe("2026년 12월 25일 금요일까지 약 29주 남았습니다.");
  });
});
