import { describe, expect, it } from "vitest";

import { detectDateQuery, formatDateAnswer, phraseHasTime } from "./date-query.js";

describe("detectDateQuery — extract the date phrase from a date question", () => {
  it("extracts a relative / ISO date phrase from the framing", () => {
    expect(detectDateQuery("what's the date next Friday?")).toBe("next Friday");
    expect(detectDateQuery("what day is in 3 weeks?")).toBe("in 3 weeks");
    expect(detectDateQuery("when is tomorrow")).toBe("tomorrow");
    expect(detectDateQuery("what day of the week is 2026-12-25?")).toBe("2026-12-25");
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
