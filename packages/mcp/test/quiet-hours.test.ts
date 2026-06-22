import { describe, expect, it } from "vitest";

import { gateProactiveNoticeSink, isQuietHour, parseQuietHours, type ProactiveNoticeSink } from "@muse/proactivity";

describe("parseQuietHours", () => {
  it("parses bare and HH:MM forms, rounding to the hour", () => {
    expect(parseQuietHours("22-7")).toEqual({ startHour: 22, endHour: 7 });
    expect(parseQuietHours("22:00-07:30")).toEqual({ startHour: 22, endHour: 7 });
  });
  it("returns undefined for malformed / empty / equal-hour input", () => {
    expect(parseQuietHours(undefined)).toBeUndefined();
    expect(parseQuietHours("nonsense")).toBeUndefined();
    expect(parseQuietHours("25-3")).toBeUndefined();
    expect(parseQuietHours("9-9")).toBeUndefined();
  });
});

describe("isQuietHour", () => {
  it("wraps across midnight for 22-7", () => {
    const range = { startHour: 22, endHour: 7 };
    expect(isQuietHour(23, range)).toBe(true);
    expect(isQuietHour(3, range)).toBe(true);
    expect(isQuietHour(7, range)).toBe(false); // exclusive end
    expect(isQuietHour(12, range)).toBe(false);
  });
  it("handles a same-day window 9-17", () => {
    const range = { startHour: 9, endHour: 17 };
    expect(isQuietHour(12, range)).toBe(true);
    expect(isQuietHour(8, range)).toBe(false);
    expect(isQuietHour(17, range)).toBe(false);
  });
});

describe("gateProactiveNoticeSink", () => {
  const notice = { title: "Heads up", text: "the page changed", kind: "web-watch" };
  function recordingSink(): { sink: ProactiveNoticeSink; sent: string[] } {
    const sent: string[] = [];
    return { sink: { deliver: async (n) => { sent.push(n.title); } }, sent };
  }

  it("suppresses delivery during the quiet window", async () => {
    const { sink, sent } = recordingSink();
    const held: string[] = [];
    const gated = gateProactiveNoticeSink(sink, {
      quietHours: { startHour: 22, endHour: 7 },
      now: () => new Date(2026, 4, 1, 23, 0, 0),
      onSuppress: (n) => held.push(n.title)
    });
    await gated.deliver(notice);
    expect(sent).toEqual([]);
    expect(held).toEqual(["Heads up"]);
  });

  it("delivers normally outside the window", async () => {
    const { sink, sent } = recordingSink();
    const gated = gateProactiveNoticeSink(sink, {
      quietHours: { startHour: 22, endHour: 7 },
      now: () => new Date(2026, 4, 1, 12, 0, 0)
    });
    await gated.deliver(notice);
    expect(sent).toEqual(["Heads up"]);
  });

  it("returns the original sink unchanged when no window is set", async () => {
    const { sink, sent } = recordingSink();
    const gated = gateProactiveNoticeSink(sink, {});
    expect(gated).toBe(sink);
    await gated.deliver(notice);
    expect(sent).toEqual(["Heads up"]);
  });
});
