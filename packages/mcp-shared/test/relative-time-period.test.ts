import { describe, expect, it } from "vitest";

import { recurrenceFromPhrase, resolveRelativeTimePhrase, stripRecurrencePrefix } from "../src/loopback-relative-time.js";

// Reference: Wednesday 2026-06-03 09:30 UTC. Assertions are timezone-robust
// (day counts / local getHours / KO-equals-EN), never a hard-coded ISO.
const now = (): Date => new Date("2026-06-03T09:30:00Z");

describe("recurring-reminder phrases — cadence prefix stripped for the FIRST occurrence + cadence inferred", () => {
  // "매주 월요일 아침 9시" used to ERROR: the resolver rejected the whole phrase
  // because of the leading cadence word, so a weekly medication reminder was lost.
  it("resolves '매주 <요일> <time>' to the same future date as the bare weekday", () => {
    const monday = resolveRelativeTimePhrase("매주 월요일 아침 9시", now);
    const bareMonday = resolveRelativeTimePhrase("월요일 아침 9시", now);
    expect(monday?.toISOString()).toBe(bareMonday?.toISOString());
    expect(monday && monday.getTime() > now().getTime()).toBe(true);
  });

  it("resolves '매일 <time>' and 'every monday <time>' instead of returning undefined", () => {
    expect(resolveRelativeTimePhrase("매일 아침 8시", now)).toBeInstanceOf(Date);
    expect(resolveRelativeTimePhrase("every monday 9am", now)?.toISOString())
      .toBe(resolveRelativeTimePhrase("monday 9am", now)?.toISOString());
  });

  it("stripRecurrencePrefix removes only a genuine leading cadence token", () => {
    expect(stripRecurrencePrefix("매주 월요일 아침 9시")).toBe("월요일 아침 9시");
    expect(stripRecurrencePrefix("매일 아침 8시")).toBe("아침 8시");
    expect(stripRecurrencePrefix("every week monday")).toBe("monday");
    expect(stripRecurrencePrefix("every monday 9am")).toBe("monday 9am");
    expect(stripRecurrencePrefix("내일 오후 3시")).toBe("내일 오후 3시");
    expect(stripRecurrencePrefix("월요일 9시")).toBe("월요일 9시");
  });

  it("recurrenceFromPhrase infers the cadence (KO + EN), undefined for one-shot", () => {
    expect(recurrenceFromPhrase("매일 아침 8시")).toBe("daily");
    expect(recurrenceFromPhrase("매주 월요일 아침 9시")).toBe("weekly");
    expect(recurrenceFromPhrase("every friday 6pm")).toBe("weekly");
    expect(recurrenceFromPhrase("매달 1일")).toBe("monthly");
    expect(recurrenceFromPhrase("매년 생일")).toBe("yearly");
    expect(recurrenceFromPhrase("내일 오후 3시")).toBeUndefined();
  });
});

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

describe("resolveRelativeTimePhrase — bare day-of-month ('the 25th', 'on the 1st')", () => {
  // Reference is the 3rd of June.
  it("resolves a day still ahead this month to THIS month ('the 25th' → the 25th)", () => {
    for (const phrase of ["the 25th", "on the 25th"]) {
      const r = resolveRelativeTimePhrase(phrase, now)!;
      expect(r, phrase).toBeDefined();
      expect(r.getDate(), phrase).toBe(25);
      expect(r.getMonth(), phrase).toBe(5); // still June
      expect(r.getTime(), phrase).toBeGreaterThan(now().getTime());
    }
  });

  it("rolls a day already PAST this month to next month ('the 1st' on the 3rd → next month's 1st)", () => {
    const r = resolveRelativeTimePhrase("the 1st", now)!;
    expect(r.getDate()).toBe(1);
    expect(r.getMonth()).toBe(6); // July
  });

  it("parses an explicit time ('on the 15th at 3pm' → the 15th at 15:00)", () => {
    const r = resolveRelativeTimePhrase("on the 15th at 3pm", now)!;
    expect(r.getDate()).toBe(15);
    expect(r.getMonth()).toBe(5);
    expect(r.getHours()).toBe(15);
  });

  it("defaults to the 9am bare-day hour when no time is given", () => {
    expect(resolveRelativeTimePhrase("the 10th", now)!.getHours()).toBe(9);
  });

  it("rejects an impossible day-of-month ('the 99th' → undefined), never a rolled-over date", () => {
    expect(resolveRelativeTimePhrase("the 99th", now)).toBeUndefined();
    expect(resolveRelativeTimePhrase("the 0th", now)).toBeUndefined();
  });

  it("rolls a day absent from the next month onto the month that HAS it — no JS Date overflow", () => {
    // "the 31st" late on Jan 31 must land on March 31, NOT March 3
    // (new Date(2026, 1, 31) overflows Feb → March 3). getDate is the discriminator.
    const r31 = resolveRelativeTimePhrase("the 31st", () => new Date(2026, 0, 31, 22, 0, 0, 0))!;
    expect(r31).toBeDefined();
    expect(r31.getMonth()).toBe(2); // March
    expect(r31.getDate()).toBe(31);
    // "the 30th" on Jan 30 → Feb has no 30th → March 30 (old code gave March 2)
    const r30 = resolveRelativeTimePhrase("the 30th", () => new Date(2026, 0, 30, 22, 0, 0, 0))!;
    expect(r30.getMonth()).toBe(2);
    expect(r30.getDate()).toBe(30);
    // "the 29th" on Jan 29 2026 (non-leap) → March 29 (old code gave March 1)
    const r29 = resolveRelativeTimePhrase("the 29th", () => new Date(2026, 0, 29, 22, 0, 0, 0))!;
    expect(r29.getMonth()).toBe(2);
    expect(r29.getDate()).toBe(29);
  });

  it("does NOT regress weekday / duration phrases sharing nearby grammar", () => {
    expect(resolveRelativeTimePhrase("next monday", now)!.getDay()).toBe(1);
    expect(Math.round((resolveRelativeTimePhrase("in 2 weeks", now)!.getTime() - now().getTime()) / 86_400_000)).toBe(14);
  });
});

describe("resolveRelativeTimePhrase — month-qualified dates ('the Nth of next month', 'end of next month')", () => {
  // Reference is Wednesday 2026-06-03 (June; next month = July).
  it("pins a day to NEXT month ('the 25th of next month' → July 25)", () => {
    const r = resolveRelativeTimePhrase("the 25th of next month", now)!;
    expect(r.getDate()).toBe(25);
    expect(r.getMonth()).toBe(6); // July
  });

  it("pins a day to THIS month literally, even a day already passed ('the 1st of this month' → June 1)", () => {
    const r = resolveRelativeTimePhrase("the 1st of this month", now)!;
    expect(r.getDate()).toBe(1);
    expect(r.getMonth()).toBe(5); // June, honoured literally
  });

  it("parses an explicit time on a month-qualified day ('on the 15th of next month at 3pm')", () => {
    const r = resolveRelativeTimePhrase("on the 15th of next month at 3pm", now)!;
    expect(r.getDate()).toBe(15);
    expect(r.getMonth()).toBe(6);
    expect(r.getHours()).toBe(15);
  });

  it("'end of next month' lands on the last day of July (31st)", () => {
    const r = resolveRelativeTimePhrase("end of next month", now)!;
    expect(r.getDate()).toBe(31);
    expect(r.getMonth()).toBe(6); // July
  });

  it("rejects a day absent from the target month, never a silent roll ('the 31st of next month' is valid in July; nonsense days reject)", () => {
    // July HAS a 31st, so this resolves; but an impossible ordinal still rejects.
    expect(resolveRelativeTimePhrase("the 31st of next month", now)!.getDate()).toBe(31);
    expect(resolveRelativeTimePhrase("the 99th of next month", now)).toBeUndefined();
  });

  it("does NOT regress the bare day-of-month or the plain 'end of the month'", () => {
    expect(resolveRelativeTimePhrase("the 25th", now)!.getDate()).toBe(25);
    expect(resolveRelativeTimePhrase("end of the month", now)!.getMonth()).toBe(5); // still June
  });
});

describe("resolveRelativeTimePhrase — colloquial Korean time-of-day words (아침/저녁/밤/새벽)", () => {
  it("아침 (morning) reads as AM: '내일 아침 8시' → next day 08:00", () => {
    const resolved = resolveRelativeTimePhrase("내일 아침 8시", now)!;
    expect(resolved.getHours()).toBe(8);
    expect(resolved.getMinutes()).toBe(0);
    const today = resolveRelativeTimePhrase("오늘 아침 8시", now)!;
    expect(Math.round((resolved.getTime() - today.getTime()) / 86_400_000)).toBe(1);
  });

  it("저녁 (evening) reads as PM: '오늘 저녁 7시' → today 19:00", () => {
    expect(resolveRelativeTimePhrase("오늘 저녁 7시", now)!.getHours()).toBe(19);
  });

  it("밤 (night) reads as PM, but 밤 12시 is midnight", () => {
    expect(resolveRelativeTimePhrase("밤 10시", now)!.getHours()).toBe(22);
    expect(resolveRelativeTimePhrase("밤 12시", now)!.getHours()).toBe(0);
  });

  it("새벽 (dawn) reads as AM: '새벽 5시' → 05:00", () => {
    expect(resolveRelativeTimePhrase("새벽 5시", now)!.getHours()).toBe(5);
  });

  it("keeps 반 (half past) with a colloquial period: '내일 저녁 6시 반' → 18:30", () => {
    const resolved = resolveRelativeTimePhrase("내일 저녁 6시 반", now)!;
    expect(resolved.getHours()).toBe(18);
    expect(resolved.getMinutes()).toBe(30);
  });

  it("점심 → noon; the formal 오후/오전 still work unchanged (no regression)", () => {
    expect(resolveRelativeTimePhrase("점심", now)!.getHours()).toBe(12);
    expect(resolveRelativeTimePhrase("오후 3시", now)!.getHours()).toBe(15);
    expect(resolveRelativeTimePhrase("오전 9시", now)!.getHours()).toBe(9);
  });
});

describe("resolveRelativeTimePhrase — English day-part word + a specific hour (AM/PM from the word)", () => {
  it("standalone 'tonight at 8' / 'this evening at 7' read as PM today", () => {
    expect(resolveRelativeTimePhrase("tonight at 8", now)!.getHours()).toBe(20);
    expect(resolveRelativeTimePhrase("this evening at 7", now)!.getHours()).toBe(19);
  });

  it("'this morning at 8' reads as AM today", () => {
    expect(resolveRelativeTimePhrase("this morning at 8", now)!.getHours()).toBe(8);
  });

  it("day-headed 'tomorrow morning at 9' / 'tomorrow evening at 6' / 'tomorrow night at 10'", () => {
    const morning = resolveRelativeTimePhrase("tomorrow morning at 9", now)!;
    expect(morning.getHours()).toBe(9);
    expect(resolveRelativeTimePhrase("tomorrow evening at 6", now)!.getHours()).toBe(18);
    expect(resolveRelativeTimePhrase("tomorrow night at 10", now)!.getHours()).toBe(22);
    // about a day ahead of the same time anchored to today
    const todayMorning = resolveRelativeTimePhrase("this morning at 9", now)!;
    expect(Math.round((morning.getTime() - todayMorning.getTime()) / 86_400_000)).toBe(1);
  });

  it("a weekday + day-part + hour works ('monday morning at 9')", () => {
    expect(resolveRelativeTimePhrase("monday morning at 9", now)!.getHours()).toBe(9);
  });

  it("an EXPLICIT am/pm is honoured over the day-part bias, and 'tonight at 12' is midnight", () => {
    expect(resolveRelativeTimePhrase("tonight at 8pm", now)!.getHours()).toBe(20);
    expect(resolveRelativeTimePhrase("tonight at 12", now)!.getHours()).toBe(0);
  });

  it("a bare day-part still resolves to its default hour (no regression)", () => {
    expect(resolveRelativeTimePhrase("tomorrow morning", now)!.getHours()).toBe(9);
    expect(resolveRelativeTimePhrase("this evening", now)!.getHours()).toBe(18);
  });
});

describe("resolveRelativeTimePhrase — a BARE duration ('2 hours', '30 minutes', '2h') is an offset from now", () => {
  // now = Wed 2026-06-03 09:30:00 UTC
  const ms = (phrase: string): number => resolveRelativeTimePhrase(phrase, now)!.getTime() - now().getTime();

  it("parses bare full-word durations the way 'in N <unit>' does", () => {
    expect(ms("2 hours")).toBe(2 * 3_600_000);
    expect(ms("30 minutes")).toBe(30 * 60_000);
    expect(ms("3 days")).toBe(3 * 86_400_000);
    expect(ms("a week")).toBe(7 * 86_400_000);
  });

  it("parses bare compact durations (2h, 90m, 2d, 2w)", () => {
    expect(ms("2h")).toBe(2 * 3_600_000);
    expect(ms("90m")).toBe(90 * 60_000);
    expect(ms("2d")).toBe(2 * 86_400_000);
    expect(ms("2w")).toBe(2 * 7 * 86_400_000);
  });

  it("a bare duration equals its explicit 'in …' form", () => {
    expect(resolveRelativeTimePhrase("2 hours", now)!.toISOString()).toBe(resolveRelativeTimePhrase("in 2 hours", now)!.toISOString());
    expect(resolveRelativeTimePhrase("2h", now)!.toISOString()).toBe(resolveRelativeTimePhrase("in 2h", now)!.toISOString());
  });

  it("still rejects an unknown unit and keeps a bare hour as a clock time (no false positive)", () => {
    expect(resolveRelativeTimePhrase("3 horses", now)).toBeUndefined();
    expect(resolveRelativeTimePhrase("5", now)!.getHours()).toBe(5); // bare number = 24h clock hour, NOT 5 of a unit
  });
});

describe("resolveRelativeTimePhrase — Feb 29 year-roll must not overflow into a wrong date", () => {
  // The single +1-year roll built new Date(year+1, monthIndex, day) with no
  // re-check, so "feb 29" asked after it passed in a leap year silently became
  // March 1 of the (non-leap) next year. Fail safe: return undefined, never a
  // date the user did not ask for.
  it("en: 'feb 29' after it passed in a leap year does NOT become March 1 next year", () => {
    // ref 2028-06-01 (2028 leap; Feb 29 2028 already passed) → roll would give
    // new Date(2029,1,29) = Feb 29 2029 → 2029 non-leap → March 1.
    expect(resolveRelativeTimePhrase("feb 29", () => new Date(2028, 5, 1, 12, 0, 0, 0))).toBeUndefined();
  });

  it("ko: '2월 29일' after it passed in a leap year does NOT become March 1 next year", () => {
    expect(resolveRelativeTimePhrase("2월 29일", () => new Date(2028, 5, 1, 12, 0, 0, 0))).toBeUndefined();
  });

  it("a valid day still rolls a year forward when this year's has passed (no false undefined)", () => {
    const r = resolveRelativeTimePhrase("mar 5", () => new Date(2026, 5, 1, 12, 0, 0, 0))!;
    expect(r).toBeDefined();
    expect(r.getMonth()).toBe(2); // March
    expect(r.getDate()).toBe(5);
    expect(r.getFullYear()).toBe(2027); // rolled to next year, day intact
  });
});
