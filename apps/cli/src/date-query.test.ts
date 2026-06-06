import { describe, expect, it } from "vitest";

import { detectDateQuery, formatDateAnswer, phraseHasTime } from "./date-query.js";

describe("detectDateQuery — extract the date phrase from a date question", () => {
  it("extracts a relative / ISO date phrase from the framing", () => {
    expect(detectDateQuery("what's the date next Friday?")).toBe("next Friday");
    expect(detectDateQuery("what day is in 3 weeks?")).toBe("in 3 weeks");
    expect(detectDateQuery("when is tomorrow")).toBe("tomorrow");
    expect(detectDateQuery("what day of the week is 2026-12-25?")).toBe("2026-12-25");
  });

  it("extracts the phrase from a Korean suffix-framed date question", () => {
    expect(detectDateQuery("100일 후가 며칠이야?")).toBe("100일 후");
    expect(detectDateQuery("3주 후는 며칠?")).toBe("3주 후");
    expect(detectDateQuery("내일 며칠이야")).toBe("내일");
    expect(detectDateQuery("다음 주 금요일은 무슨 요일이야?")).toBe("다음 주 금요일");
  });

  it("does NOT grab a Korean countdown ('…까지 며칠 남았어') as a date phrase", () => {
    expect(detectDateQuery("크리스마스까지 며칠 남았어?")).toBeNull();
  });

  it("answers a Korean phrase in Korean with the right topic particle", () => {
    expect(formatDateAnswer("100일 후", "2026-09-15T12:00:00Z")).toMatch(/^100일 후는 .*입니다\.$/u);
    expect(formatDateAnswer("내일", "2026-06-08T12:00:00Z")).toMatch(/^내일은 /u); // batchim → 은
  });

  it("defaults to 'today' for a bare date question", () => {
    expect(detectDateQuery("what's the date?")).toBe("today");
    expect(detectDateQuery("what day is it?")).toBe("today");
    expect(detectDateQuery("what is the date today")).toBe("today");
  });

  it("returns null for a non-date question, so recall is never hijacked", () => {
    expect(detectDateQuery("what's my Q3 budget?")).toBeNull();
    expect(detectDateQuery("who is my manager?")).toBeNull();
    expect(detectDateQuery("summarize the launch plan")).toBeNull();
  });

  it("extracts an event-name remainder (which the caller's parseReminderDueAt gate then rejects)", () => {
    // detectDateQuery only strips the framing; the precision gate is the date parser.
    expect(detectDateQuery("when is my dentist appointment?")).toBe("my dentist appointment");
  });
});

describe("formatDateAnswer + phraseHasTime", () => {
  it("formats the resolved date with the weekday, capitalising the phrase", () => {
    expect(formatDateAnswer("next Friday", "2026-06-12T00:00:00")).toBe("Next Friday is Friday, June 12, 2026.");
    expect(formatDateAnswer("today", "2026-06-06T00:00:00")).toBe("Today is Saturday, June 6, 2026.");
  });

  it("includes the time only when asked (an explicit-time phrase)", () => {
    expect(formatDateAnswer("tomorrow at 6pm", "2026-06-07T18:00:00", { includeTime: true })).toContain("6:00");
    expect(formatDateAnswer("next Friday", "2026-06-12T18:00:00")).not.toContain(":00");
  });

  it("phraseHasTime detects an explicit clock time", () => {
    expect(phraseHasTime("tomorrow at 6pm")).toBe(true);
    expect(phraseHasTime("in 3 hours")).toBe(false); // a duration, not a clock time
    expect(phraseHasTime("next Friday")).toBe(false);
  });
});
