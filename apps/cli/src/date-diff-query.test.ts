import { describe, expect, it } from "vitest";

import { detectDateDiffQuery, formatDateDiff } from "./date-diff-query.js";

const now = new Date("2026-06-05T12:00:00"); // bare month-days resolve to 2026

describe("detectDateDiffQuery — exact day count between two literal dates", () => {
  it("counts between two bare month-days (this year)", () => {
    const r = detectDateDiffQuery("how many days between June 1 and August 15?", now)!;
    expect(r.days).toBe(75); // Jun 1 → Aug 15, 2026
    expect(r.unit).toBe("days");
  });

  it("counts between ISO dates — exactly, where the 8B was off by one", () => {
    expect(detectDateDiffQuery("how many days from 2026-03-01 to 2026-11-20?", now)!.days).toBe(264); // 8B answered 263
  });

  it("supports weeks/months and 'how long'", () => {
    expect(detectDateDiffQuery("how many weeks between January 1 2026 and December 31 2026?", now)!.days).toBe(364); // → 52 weeks
    expect(detectDateDiffQuery("how long from June 1 to June 30", now)!.days).toBe(29);
  });

  it("rolls a from→to span that crosses the year boundary (Dec → Jan)", () => {
    const r = detectDateDiffQuery("how many days from December 20 to January 5", now)!;
    expect(r.days).toBe(16); // Dec 20 2026 → Jan 5 2027
    expect(r.to.getFullYear()).toBe(2027);
  });

  it("returns null when the cross-year roll would land on an impossible date (Feb 29 → non-leap year)", () => {
    // A year-less "February 29" that sorts before the start rolls forward one
    // year; if that next year isn't a leap year the old code silently rolled
    // Feb 29 → Mar 1 and gave a confident wrong count over a date never typed.
    const leapNow = new Date("2028-01-01T12:00:00"); // Feb 29 2028 parses as valid
    expect(detectDateDiffQuery("how many days from March 1 to February 29", leapNow)).toBeNull();
  });

  it("returns null for an IMPOSSIBLE calendar date — never silently rolls it into the next month", () => {
    // Feb 30 / Apr 31 / non-leap Feb 29 don't exist; the old guard only checked
    // day 1–31, so `new Date(2026,1,30)` rolled to Mar 2 and the fast-path gave a
    // confident wrong count over a date the user never typed. Now it falls through
    // to recall (null), the documented precision-first behavior.
    expect(detectDateDiffQuery("how many days between February 1 and February 30", now)).toBeNull();
    expect(detectDateDiffQuery("how many days between April 1 and April 31", now)).toBeNull();
    expect(detectDateDiffQuery("how many days between 2026-02-01 and 2026-02-30", now)).toBeNull();
    expect(detectDateDiffQuery("how many days between January 1 and February 29", now)).toBeNull(); // 2026 is not a leap year
  });

  it("still accepts a real leap day in a leap year", () => {
    const leapNow = new Date("2028-01-01T12:00:00");
    expect(detectDateDiffQuery("how many days between February 1 and February 29", leapNow)!.days).toBe(28); // 2028 IS a leap year
  });

  it("returns null for non-difference questions (recall is never hijacked)", () => {
    expect(detectDateDiffQuery("how many days until Christmas?", now)).toBeNull(); // a countdown, not a difference
    expect(detectDateDiffQuery("how many people are coming?", now)).toBeNull();
    expect(detectDateDiffQuery("how long between the meetings?", now)).toBeNull(); // not parseable dates
    expect(detectDateDiffQuery("summarize the plan", now)).toBeNull();
  });
});

describe("formatDateDiff — readable, pluralised", () => {
  it("frames days / weeks / months with the resolved dates", () => {
    expect(formatDateDiff({ unit: "days", days: 75, from: new Date("2026-06-01T00:00:00"), to: new Date("2026-08-15T00:00:00") }))
      .toBe("There are 75 days between June 1, 2026 and August 15, 2026.");
    expect(formatDateDiff({ unit: "weeks", days: 364, from: new Date("2026-01-01T00:00:00"), to: new Date("2026-12-31T00:00:00") }))
      .toContain("about 52 weeks");
    expect(formatDateDiff({ unit: "days", days: 1, from: new Date("2026-06-01T00:00:00"), to: new Date("2026-06-02T00:00:00") }))
      .toContain("is 1 day");
  });
});
