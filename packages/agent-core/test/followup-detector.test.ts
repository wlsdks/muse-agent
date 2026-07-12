import { describe, expect, it } from "vitest";

import { RULE_FOLLOWUP_FUTURE_HORIZON_MS, detectUnscheduledRememberIntent, extractFollowupPromises } from "../src/followup-detector.js";

// Wednesday (getDay() === 3).
const now = new Date("2026-05-13T10:00:00.000Z");

describe("extractFollowupPromises — future-horizon sanity bound", () => {
  it("drops a promise scheduled beyond the 365-day horizon (`in 9999 days` would queue a follow-up ~27 years out that never meaningfully fires) — parity with the LLM detector's bound", () => {
    expect(extractFollowupPromises("ping me in 9999 days", { now })).toHaveLength(0);
    // 366 days is just past the horizon → dropped.
    expect(extractFollowupPromises("remind me in 366 days", { now })).toHaveLength(0);
  });

  it("keeps a promise inside the horizon (a few hundred days out is a legitimate long-range reminder)", () => {
    const result = extractFollowupPromises("circle back in 300 days", { now });
    expect(result).toHaveLength(1);
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(300 * 86_400_000);
  });

  it("exports a 365-day horizon constant matching the LLM detector", () => {
    expect(RULE_FOLLOWUP_FUTURE_HORIZON_MS).toBe(365 * 86_400_000);
  });
});

describe("extractFollowupPromises — negated promises are not queued (assistant declined)", () => {
  it("suppresses a follow-up the assistant explicitly REFUSED (won't / will not / can't / never)", () => {
    expect(extractFollowupPromises("I won't remind you in 30 minutes.", { now })).toHaveLength(0);
    expect(extractFollowupPromises("I will not check tomorrow morning.", { now })).toHaveLength(0);
    expect(extractFollowupPromises("I can't follow up in 2 hours.", { now })).toHaveLength(0);
    expect(extractFollowupPromises("I never reach back out tomorrow.", { now })).toHaveLength(0);
  });

  it("still queues a genuine (non-negated) promise with the same time phrase", () => {
    expect(extractFollowupPromises("I'll remind you in 30 minutes.", { now })).toHaveLength(1);
    expect(extractFollowupPromises("I'll check tomorrow morning.", { now })).toHaveLength(1);
  });

  it("does not let a distant earlier 'not' suppress a later genuine promise", () => {
    // the negation window is local to the time phrase; an unrelated "not" far
    // earlier in the turn must not swallow a real follow-up.
    const text = "That's not what I meant earlier. Anyway, I'll ping you in 15 minutes.";
    expect(extractFollowupPromises(text, { now })).toHaveLength(1);
  });
});

describe("extractFollowupPromises — English relative", () => {
  it("matches `in N minutes`", () => {
    const result = extractFollowupPromises("I'll check back in 30 minutes.", { now });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      confidence: "high",
      kind: "relative-minutes",
      scheduledFor: new Date(now.getTime() + 30 * 60_000)
    });
  });

  it("matches `in N hours`", () => {
    const result = extractFollowupPromises("Ping me in 2 hours.", { now });
    expect(result[0]?.kind).toBe("relative-hours");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(2 * 3_600_000);
  });

  it("matches `in N days`", () => {
    const result = extractFollowupPromises("Let me revisit in 3 days.", { now });
    expect(result[0]?.kind).toBe("relative-days");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(3 * 86_400_000);
  });

  it("accepts the `hr`/`hrs` short form", () => {
    expect(extractFollowupPromises("in 4 hrs", { now })[0]?.kind).toBe("relative-hours");
    expect(extractFollowupPromises("in 1 hr", { now })[0]?.kind).toBe("relative-hours");
  });

  it("ignores zero / negative / non-numeric durations", () => {
    expect(extractFollowupPromises("in 0 minutes", { now })).toHaveLength(0);
    expect(extractFollowupPromises("in many minutes", { now })).toHaveLength(0);
  });

  it("ignores a ZERO Korean relative duration on every unit (분/시간/일) — no now+0 followup", () => {
    // The `value <= 0` guard is per-unit; only the English path tested zero. A
    // "0분 뒤" must not schedule a meaningless immediate followup, while a real
    // duration still does.
    expect(extractFollowupPromises("0분 뒤에 알려줘", { now })).toHaveLength(0);
    expect(extractFollowupPromises("0시간 후에 확인", { now })).toHaveLength(0);
    expect(extractFollowupPromises("0일 이내에 처리", { now })).toHaveLength(0);
    expect(extractFollowupPromises("5분 뒤에 알려줘", { now })).toHaveLength(1); // control: a real one still fires
  });
});

describe("extractFollowupPromises — English `tomorrow` slot", () => {
  it("defaults to morning when no slot is named", () => {
    const result = extractFollowupPromises("Let's revisit tomorrow.", { now });
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe("low");
    expect(result[0]?.kind).toBe("tomorrow-slot");
    const expected = new Date(now);
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 0, 0, 0);
    expect(result[0]?.scheduledFor.getTime()).toBe(expected.getTime());
  });

  it("honours `tomorrow afternoon` / `tomorrow night`", () => {
    const aft = extractFollowupPromises("I'll send the doc tomorrow afternoon.", { now })[0];
    const nt = extractFollowupPromises("Ping me tomorrow night.", { now })[0];
    expect(aft?.scheduledFor.getHours()).toBe(14);
    expect(nt?.scheduledFor.getHours()).toBe(21);
  });

  it("respects user-supplied slot overrides", () => {
    const result = extractFollowupPromises("tomorrow morning", {
      now,
      slotHours: { morning: 7 }
    });
    expect(result[0]?.scheduledFor.getHours()).toBe(7);
  });

  it("does NOT emit a promise when slotHours has a non-finite hour (NaN / Infinity from a corrupt env / settings parse) — Invalid Date would crash the followup-capture-hook's `.toISOString()` downstream", () => {
    // setHours(NaN, ...) produces an Invalid Date; `.toISOString()`
    // on that throws RangeError. The detector's contract is "every
    // emitted FollowupPromise has a serialisable scheduledFor" so
    // the afterTurn hook never blows up on a `tomorrow morning`
    // phrase paired with a corrupt slot configuration.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = extractFollowupPromises("see you tomorrow morning", {
        now,
        slotHours: { morning: bad }
      });
      expect(
        result.every((promise) => Number.isFinite(promise.scheduledFor.getTime())),
        `slotHours.morning=${bad.toString()}: must NOT emit a promise with an Invalid Date scheduledFor`
      ).toBe(true);
      // Specifically: the `tomorrow-slot` branch produced nothing (or
      // the invalid promise was filtered) — no Invalid Date sneaks
      // through.
      expect(
        result.filter((promise) => promise.kind === "tomorrow-slot"),
        `slotHours.morning=${bad.toString()}: tomorrow-slot promises must be empty`
      ).toHaveLength(0);
    }
  });
});

describe("extractFollowupPromises — English `at HH(:MM)? (am|pm)?`", () => {
  it("schedules `at 3pm` for today when 3pm is still ahead", () => {
    const morning = new Date("2026-05-13T01:00:00.000Z"); // 10:00 KST
    const result = extractFollowupPromises("I'll send the doc at 3pm.", { now: morning });
    expect(result[0]?.scheduledFor.getHours()).toBe(15);
    expect(result[0]?.confidence).toBe("high");
  });

  it("rolls to tomorrow when the named hour has already passed", () => {
    const evening = new Date("2026-05-13T16:00:00.000Z"); // 01:00 next day KST
    const result = extractFollowupPromises("send at 6am", { now: evening });
    expect(result[0]?.scheduledFor.getTime()).toBeGreaterThan(evening.getTime());
  });

  it("converts 12am / 12pm correctly", () => {
    const noon = extractFollowupPromises("at 12pm", { now })[0];
    const midnight = extractFollowupPromises("at 12am", { now })[0];
    expect(noon?.scheduledFor.getHours()).toBe(12);
    expect(midnight?.scheduledFor.getHours()).toBe(0);
  });

  it("rejects a 12-hour-clock contradiction (`at 15pm`, `at 0am`) instead of rolling to the wrong time", () => {
    // Pre-fix `15 + 12 = 27` → setHours(27) silently rolled to ~3am
    // next day. A bare 24h hour (no meridiem) is still accepted.
    expect(extractFollowupPromises("ping me at 15pm", { now })
      .filter((p) => p.kind === "today-at")).toHaveLength(0);
    expect(extractFollowupPromises("at 0am", { now })
      .filter((p) => p.kind === "today-at")).toHaveLength(0);
    expect(extractFollowupPromises("at 13pm", { now })
      .filter((p) => p.kind === "today-at")).toHaveLength(0);
    const bare24 = extractFollowupPromises("at 20", { now }).find((p) => p.kind === "today-at");
    expect(bare24?.scheduledFor.getHours()).toBe(20);
  });
});

describe("extractFollowupPromises — Korean relative", () => {
  it("matches `N분 뒤`", () => {
    const result = extractFollowupPromises("30분 뒤에 다시 확인할게요.", { now });
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("korean-relative-minutes");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it("matches `N시간 후`", () => {
    const result = extractFollowupPromises("2시간 후에 보고 드리겠습니다.", { now });
    expect(result[0]?.kind).toBe("korean-relative-hours");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(2 * 3_600_000);
  });

  it("matches `N일 후` / `N일 뒤` / `N일 이내` (was silently dropped)", () => {
    const after = extractFollowupPromises("3일 후에 확인해서 알려드릴게요.", { now });
    expect(after).toHaveLength(1);
    expect(after[0]?.kind).toBe("korean-relative-days");
    expect(after[0]?.scheduledFor.getTime() - now.getTime()).toBe(3 * 86_400_000);

    expect(extractFollowupPromises("2일 뒤 보고드리겠습니다.", { now })[0]?.kind).toBe("korean-relative-days");
    const within = extractFollowupPromises("5일 이내에 정리해 드릴게요.", { now })[0];
    expect(within?.kind).toBe("korean-relative-days");
    expect(within?.scheduledFor.getTime() - now.getTime()).toBe(5 * 86_400_000);
  });

  it("does NOT treat a `N일에` day-of-month as a relative-days promise", () => {
    // "30일에 회의" = "meeting on the 30th", not "in 30 days".
    const result = extractFollowupPromises("30일에 회의가 잡혀 있습니다.", { now });
    expect(result.every((p) => p.kind !== "korean-relative-days")).toBe(true);
  });

  it("matches `내일 아침` with morning slot", () => {
    const result = extractFollowupPromises("내일 아침에 다시 봐 드릴게요.", { now });
    expect(result[0]?.kind).toBe("korean-tomorrow-slot");
    expect(result[0]?.scheduledFor.getHours()).toBe(9);
  });

  it("maps every Korean `내일 <slot>` variant to its slot hour (오전/점심/오후/저녁/밤), not just 아침", () => {
    // The KOREAN_SLOTS map + slot→hour resolution was only exercised for 아침;
    // each other key (점심/오후→afternoon, 저녁→evening, 밤→night, 오전→morning) is its
    // own mapping a mutant could break. Default slots: morning 9, afternoon 14,
    // evening 19, night 21.
    const cases = [
      ["내일 오전에 확인할게요.", 9],
      ["내일 점심에 다시 볼게요.", 14],
      ["내일 오후에 보고드릴게요.", 14],
      ["내일 저녁에 정리해 드릴게요.", 19],
      ["내일 밤에 알려줄게요.", 21]
    ];
    for (const [text, hour] of cases) {
      const hit = extractFollowupPromises(text, { now }).find((p) => p.kind === "korean-tomorrow-slot");
      expect(hit, `expected a korean-tomorrow-slot for "${text}"`).toBeDefined();
      expect(hit?.scheduledFor.getHours(), `"${text}" → hour`).toBe(hour);
    }
  });

  it("matches `오늘 3시에`", () => {
    const morning = new Date("2026-05-13T00:00:00.000Z"); // 09:00 KST
    const result = extractFollowupPromises("오늘 15시에 확인합니다.", { now: morning });
    const hit = result.find((p) => p.kind === "korean-today-at");
    expect(hit).toBeDefined();
    expect(hit?.scheduledFor.getHours()).toBe(15);
  });

  it("does NOT match `시간` (hour-unit) as `시 + 간` for the today-at pattern", () => {
    // "5시간 뒤" must classify as korean-relative-hours, not korean-today-at.
    const result = extractFollowupPromises("5시간 뒤에 회신할게요.", { now });
    expect(result.every((p) => p.kind !== "korean-today-at")).toBe(true);
    expect(result.some((p) => p.kind === "korean-relative-hours")).toBe(true);
  });
});

describe("extractFollowupPromises — multi-promise + dedupe", () => {
  it("emits one entry per distinct resolved minute even when paraphrased", () => {
    const result = extractFollowupPromises(
      "Ping me in 30 minutes — actually, in 30 min works too.",
      { now }
    );
    expect(result).toHaveLength(1);
  });

  it("emits independent entries for distinct times in one turn", () => {
    const result = extractFollowupPromises(
      "I'll check in 1 hour, and follow up tomorrow morning.",
      { now }
    );
    const kinds = result.map((r) => r.kind).sort();
    expect(kinds).toEqual(["relative-hours", "tomorrow-slot"]);
  });

  it("returns empty for non-followup text", () => {
    expect(extractFollowupPromises("I'll think about it.", { now })).toHaveLength(0);
    expect(extractFollowupPromises("Sounds good!", { now })).toHaveLength(0);
    expect(extractFollowupPromises("", { now })).toHaveLength(0);
  });
});

describe("extractFollowupPromises — Korean weekday (false-done reminder root, rule 1a)", () => {
  it("resolves a bare weekday to its next occurrence this week, default morning hour", () => {
    const hit = extractFollowupPromises("금요일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-weekday");
    expect(hit).toBeDefined();
    expect(hit?.confidence).toBe("low");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 4, 15, 9, 0, 0, 0));
  });

  it("honours an explicit clock time on the weekday (24h number) — high confidence", () => {
    const hit = extractFollowupPromises("금요일 15시에 알려줄게요.", { now }).find((p) => p.kind === "korean-weekday");
    expect(hit).toBeDefined();
    expect(hit?.confidence).toBe("high");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 4, 15, 15, 0, 0, 0));
  });

  it("다음주/담주 FORCES next week even though the weekday is still ahead this week", () => {
    const nextJu = extractFollowupPromises("다음주 금요일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-weekday");
    expect(nextJu?.scheduledFor).toEqual(new Date(2026, 4, 22, 9, 0, 0, 0));
    const damJu = extractFollowupPromises("담주 금요일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-weekday");
    expect(damJu?.scheduledFor).toEqual(new Date(2026, 4, 22, 9, 0, 0, 0));
  });

  it("이번주 behaves like the unqualified default (this week if still ahead)", () => {
    const hit = extractFollowupPromises("이번주 금요일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-weekday");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 4, 15, 9, 0, 0, 0));
  });

  it("boundary: 오늘이 금요일인데 '금요일' — still ahead today vs already passed today", () => {
    const fridayMorning = new Date(2026, 4, 15, 0, 0, 0, 0); // Friday, before the 9am default slot
    const stillAhead = extractFollowupPromises("금요일에 확인해서 알려드릴게요.", { now: fridayMorning }).find((p) => p.kind === "korean-weekday");
    expect(stillAhead?.scheduledFor).toEqual(new Date(2026, 4, 15, 9, 0, 0, 0)); // today

    const fridayAfternoon = new Date(2026, 4, 15, 15, 0, 0, 0); // Friday, after the 9am default slot has passed
    const alreadyPassed = extractFollowupPromises("금요일에 확인해서 알려드릴게요.", { now: fridayAfternoon }).find((p) => p.kind === "korean-weekday");
    expect(alreadyPassed?.scheduledFor).toEqual(new Date(2026, 4, 22, 9, 0, 0, 0)); // next Friday
  });

  it("maps every weekday character to its getDay() index (mutation guard)", () => {
    const cases: ReadonlyArray<[string, number]> = [
      ["일요일에 확인해서 알려드릴게요.", 0], ["월요일에 확인해서 알려드릴게요.", 1],
      ["화요일에 확인해서 알려드릴게요.", 2], ["수요일에 확인해서 알려드릴게요.", 3],
      ["목요일에 확인해서 알려드릴게요.", 4], ["금요일에 확인해서 알려드릴게요.", 5],
      ["토요일에 확인해서 알려드릴게요.", 6]
    ];
    for (const [text, day] of cases) {
      const hit = extractFollowupPromises(text, { now }).find((p) => p.kind === "korean-weekday");
      expect(hit, text).toBeDefined();
      expect(hit?.scheduledFor.getDay(), text).toBe(day);
    }
  });
});

describe("extractFollowupPromises — English weekday (mirrors the Korean rule)", () => {
  it("resolves a bare weekday to its next occurrence this week, default morning hour", () => {
    const hit = extractFollowupPromises("I'll check back Friday.", { now }).find((p) => p.kind === "weekday");
    expect(hit?.confidence).toBe("low");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 4, 15, 9, 0, 0, 0));
  });

  it("honours an explicit `at H(:MM)? (am|pm)?` on the weekday — high confidence with meridiem", () => {
    const hit = extractFollowupPromises("Let's meet this Friday at 3pm.", { now }).find((p) => p.kind === "weekday");
    expect(hit?.confidence).toBe("high");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 4, 15, 15, 0, 0, 0));
  });

  it("`next <weekday>` FORCES next week even when today IS that weekday", () => {
    const hit = extractFollowupPromises("I'll follow up next Wednesday.", { now }).find((p) => p.kind === "weekday");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 4, 20, 9, 0, 0, 0));
  });

  it("boundary: today IS the named weekday — still ahead vs already passed", () => {
    const wedMorning = new Date(2026, 4, 13, 0, 0, 0, 0); // Wednesday, before the 9am default slot
    const stillAhead = extractFollowupPromises("I'll ping you Wednesday.", { now: wedMorning }).find((p) => p.kind === "weekday");
    expect(stillAhead?.scheduledFor).toEqual(new Date(2026, 4, 13, 9, 0, 0, 0)); // today

    const wedEvening = new Date(2026, 4, 13, 19, 0, 0, 0); // Wednesday, after the 9am default slot has passed
    const alreadyPassed = extractFollowupPromises("I'll ping you Wednesday.", { now: wedEvening }).find((p) => p.kind === "weekday");
    expect(alreadyPassed?.scheduledFor).toEqual(new Date(2026, 4, 20, 9, 0, 0, 0)); // next Wednesday
  });

  it("rejects a 12-hour-clock contradiction on the weekday time instead of rolling to the wrong hour", () => {
    expect(extractFollowupPromises("next Friday at 15pm", { now }).filter((p) => p.kind === "weekday")).toHaveLength(0);
  });
});

describe("extractFollowupPromises — Korean absolute date (false-done reminder root, rule 1b)", () => {
  it("an unqualified day still ahead this month schedules THIS month", () => {
    const hit = extractFollowupPromises("20일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-absolute-date");
    expect(hit?.confidence).toBe("low");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 4, 20, 9, 0, 0, 0));
  });

  it("an unqualified day already PAST this month rolls to next month", () => {
    const hit = extractFollowupPromises("5일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-absolute-date");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 5, 5, 9, 0, 0, 0));
  });

  it("다음달 FORCES next month even when the day is still ahead this month", () => {
    const hit = extractFollowupPromises("다음달 20일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-absolute-date");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 5, 20, 9, 0, 0, 0));
  });

  it("explicit `N월 N일` still ahead THIS year schedules this year", () => {
    const hit = extractFollowupPromises("7월 5일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-absolute-date");
    expect(hit?.scheduledFor).toEqual(new Date(2026, 6, 5, 9, 0, 0, 0));
  });

  it("explicit `N월 N일` already PAST this year rolls to next year", () => {
    const hit = extractFollowupPromises("3월 5일에 확인해서 알려드릴게요.", { now }).find((p) => p.kind === "korean-absolute-date");
    expect(hit?.scheduledFor).toEqual(new Date(2027, 2, 5, 9, 0, 0, 0));
  });

  it("boundary: 12월 → 1월 — 다음달 in December rolls into January of NEXT year", () => {
    const decemberNow = new Date(2026, 11, 20, 10, 0, 0, 0);
    const hit = extractFollowupPromises("다음달 5일에 확인해서 알려드릴게요.", { now: decemberNow }).find((p) => p.kind === "korean-absolute-date");
    expect(hit?.scheduledFor).toEqual(new Date(2027, 0, 5, 9, 0, 0, 0));
  });

  it("boundary: 31일 없는 달 — an unqualified day that doesn't exist in the current month is DROPPED, not rolled to a different month", () => {
    const aprilNow = new Date(2026, 3, 10, 10, 0, 0, 0); // April has 30 days
    const result = extractFollowupPromises("31일에 확인해서 알려드릴게요.", { now: aprilNow });
    expect(result.filter((p) => p.kind === "korean-absolute-date")).toHaveLength(0);
  });

  it("rejects a day outside 1-31 — no match", () => {
    const result = extractFollowupPromises("45일에 확인해서 알려드릴게요.", { now });
    expect(result.filter((p) => p.kind === "korean-absolute-date")).toHaveLength(0);
  });

  it("rejects an explicit month/day that is never a valid calendar date (Feb 30)", () => {
    const result = extractFollowupPromises("2월 30일에 확인해서 알려드릴게요.", { now });
    expect(result.filter((p) => p.kind === "korean-absolute-date")).toHaveLength(0);
  });

  it("does NOT re-classify a relative-days phrase (`N일 뒤/후/이내`) as an absolute date", () => {
    const after = extractFollowupPromises("3일 후에 확인해서 알려드릴게요.", { now });
    expect(after.filter((p) => p.kind === "korean-absolute-date")).toHaveLength(0);
    expect(after.some((p) => p.kind === "korean-relative-days")).toBe(true);

    const within = extractFollowupPromises("5일 이내에 정리해 드릴게요.", { now });
    expect(within.filter((p) => p.kind === "korean-absolute-date")).toHaveLength(0);
  });
});

describe("extractFollowupPromises — the two audited sim utterances now schedule a real followup", () => {
  it("\"다음달 5일 딸 생일 기억해줘\" — the assistant's confirming echo schedules a korean-absolute-date followup", () => {
    const text = "네, 다음달 5일에 따님 생신 꼭 기억해서 알려드릴게요!";
    const result = extractFollowupPromises(text, { now });
    expect(result.some((p) => p.kind === "korean-absolute-date")).toBe(true);
    // Also survives the production commissive gate (the echo carries "알려드릴게요").
    const gated = extractFollowupPromises(text, { now, requireCommissive: true });
    expect(gated.some((p) => p.kind === "korean-absolute-date")).toBe(true);
  });

  it("\"금요일에 GPU 서버 예약 리마인드\" — the assistant's confirming echo schedules a korean-weekday followup", () => {
    const text = "네, 금요일에 GPU 서버 예약 리마인드 해드릴게요!";
    const result = extractFollowupPromises(text, { now });
    expect(result.some((p) => p.kind === "korean-weekday")).toBe(true);
    const gated = extractFollowupPromises(text, { now, requireCommissive: true });
    expect(gated.some((p) => p.kind === "korean-weekday")).toBe(true);
  });

  it("the SAME date phrase with no commitment verb is dropped under the production (requireCommissive) gate", () => {
    // A factual mention ("...is on the 5th"), not a promise — must not auto-schedule.
    const gated = extractFollowupPromises("다음달 5일이 회의입니다.", { now, requireCommissive: true });
    expect(gated.filter((p) => p.kind === "korean-absolute-date")).toHaveLength(0);
  });
});

describe("extractFollowupPromises — recurrence markers suppress the one-shot capture (FIX N1b)", () => {
  // Full recurrence support is out of scope — a wrong ONE-SHOT time is worse
  // than nothing (it fires the reminder at the wrong moment and never
  // again), so a recurrence marker (매일/매주/매달/…요일마다/마다) governing the
  // time expression drops the match entirely instead of resolving a bogus
  // single occurrence.
  it("수요일마다 6시 — no korean-weekday AND no korean-today-at bogus one-shot", () => {
    const result = extractFollowupPromises("수요일마다 6시에 회의 있는거 잊지 마", { now });
    expect(result).toHaveLength(0);
  });

  it("매일 아침 8시 — no korean-today-at bogus one-shot (today 08:00)", () => {
    const result = extractFollowupPromises("매일 아침 8시 혈압약 먹는거 잊지 마", { now });
    expect(result).toHaveLength(0);
  });

  it("매주 금요일 — no korean-weekday bogus one-shot", () => {
    const result = extractFollowupPromises("매주 금요일에 청소하는거 잊지 마", { now });
    expect(result.filter((p) => p.kind === "korean-weekday")).toHaveLength(0);
  });

  it("매달 1일 — no korean-absolute-date bogus one-shot", () => {
    const result = extractFollowupPromises("매달 1일 월세 내는거 잊지 마", { now });
    expect(result.filter((p) => p.kind === "korean-absolute-date")).toHaveLength(0);
  });

  it("control: the SAME time phrase with NO recurrence marker still schedules normally", () => {
    const result = extractFollowupPromises("수요일 6시에 회의 있는거 잊지 마", { now });
    expect(result.some((p) => p.kind === "korean-weekday")).toBe(true);
  });
});

describe("detectUnscheduledRememberIntent — the honest-caveat signal for a date the rule detector can't yet resolve", () => {
  it("true for a remember-request that pairs a marker with a date-ish token", () => {
    for (const q of [
      "다음달 5일 딸 생일 기억해줘",
      "금요일에 GPU 서버 예약 리마인드",
      "모레 병원 예약 잊지마",
      "설날에 세뱃돈 준비하는거 잊지 않게 알려줘",
      "내일모레 회의 있는거 기억해줘",
      "글피 마감인거 잊지마"
    ]) {
      expect(detectUnscheduledRememberIntent(q), q).toBe(true);
    }
  });

  it("false when EITHER the remember marker OR the date-ish token is missing (conservative, no false positives on plain chat)", () => {
    for (const q of [
      "고마워",
      "오늘 날씨 어때?",
      "내 노트 요약해줘",
      "기억해줘", // marker, no date
      "다음달에 뭐 하지", // date-ish, no marker
      "회의 일정 추가해줘", // action request, no remember marker
      "5분 뒤에 알려줘" // has a date-ish digit+일? no — "분" not "일"; no marker either sense
    ]) {
      expect(detectUnscheduledRememberIntent(q), q).toBe(false);
    }
  });

  it("false for empty / whitespace input", () => {
    expect(detectUnscheduledRememberIntent("")).toBe(false);
    expect(detectUnscheduledRememberIntent("   ")).toBe(false);
  });
});
