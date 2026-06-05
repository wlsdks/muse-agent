import { describe, expect, it } from "vitest";

import { analyzeFocusWindows, buildDayWindows, formatFocus } from "./calendar-focus.js";

const ev = (startISO: string, endISO: string, title = "mtg"): { title: string; startsAt: Date; endsAt: Date; allDay: boolean } =>
  ({ allDay: false, endsAt: new Date(endISO), startsAt: new Date(startISO), title });

// A 9:00–18:00 window (UTC, so the test is timezone-independent).
const window = { from: new Date("2026-06-08T09:00:00Z"), to: new Date("2026-06-08T18:00:00Z") };

describe("analyzeFocusWindows — longest uninterrupted free block", () => {
  it("a fully-free day is one big block (whole window), not fragmented", () => {
    const [day] = analyzeFocusWindows([], [window], 60);
    expect(day!.longestFreeMinutes).toBe(9 * 60); // 09:00–18:00
    expect(day!.totalFreeMinutes).toBe(9 * 60);
    expect(day!.meetingCount).toBe(0);
    expect(day!.fragmented).toBe(false);
  });

  it("finds the LARGEST gap, not the total — fragmented time fails even when total is ample", () => {
    // A meeting every half hour: 9:30–10, 10:30–11, … 17:30–18. Every free gap is 30m.
    const events = [];
    for (let h = 9; h < 18; h += 1) events.push(ev(`2026-06-08T${h.toString().padStart(2, "0")}:30:00Z`, `2026-06-08T${(h + 1).toString().padStart(2, "0")}:00:00Z`));
    const [day] = analyzeFocusWindows(events, [window], 60);
    expect(day!.meetingCount).toBe(9);
    expect(day!.longestFreeMinutes).toBe(30); // biggest gap is only 30m — no deep-work block
    expect(day!.totalFreeMinutes).toBeGreaterThan(4 * 60); // lots of free time, but all fragmented
    expect(day!.fragmented).toBe(true);
  });

  it("one big block clears the threshold even with meetings around it", () => {
    // A single 9–9:30 meeting leaves 9:30–18:00 (8.5h) as one block.
    const [day] = analyzeFocusWindows([ev("2026-06-08T09:00:00Z", "2026-06-08T09:30:00Z")], [window], 60);
    expect(day!.longestFreeMinutes).toBe(8 * 60 + 30);
    expect(day!.fragmented).toBe(false);
  });

  it("an all-day-equivalent meeting covering the window leaves no focus block (fragmented)", () => {
    const [day] = analyzeFocusWindows([ev("2026-06-08T08:00:00Z", "2026-06-08T19:00:00Z")], [window], 60);
    expect(day!.longestFreeMinutes).toBe(0);
    expect(day!.fragmented).toBe(true);
  });
});

describe("buildDayWindows — local working-hour windows", () => {
  it("builds N consecutive days at the given local hours", () => {
    const windows = buildDayWindows(new Date("2026-06-08T15:00:00"), 3, 9, 18);
    expect(windows).toHaveLength(3);
    for (const w of windows) {
      expect(w.from.getHours()).toBe(9); // local hours, assertion holds in any TZ
      expect(w.to.getHours()).toBe(18);
      expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
    }
    expect(windows[1]!.from.getDate()).toBe(windows[0]!.from.getDate() + 1);
  });

  it("clamps a non-positive day count to 1 and skips a degenerate window", () => {
    expect(buildDayWindows(new Date("2026-06-08T00:00:00"), 0, 9, 18)).toHaveLength(1);
    expect(buildDayWindows(new Date("2026-06-08T00:00:00"), 2, 18, 9)).toHaveLength(0); // end <= start
  });
});

describe("formatFocus", () => {
  it("flags fragmented days and cites attention residue", () => {
    const out = formatFocus([
      { dayStart: new Date("2026-06-08T09:00:00Z"), fragmented: true, longestFreeMinutes: 40, meetingCount: 6, totalFreeMinutes: 320 }
    ], 60);
    expect(out).toContain("fragmented");
    expect(out).toContain("attention residue");
  });

  it("reports a protected schedule when nothing is fragmented", () => {
    const out = formatFocus([
      { dayStart: new Date("2026-06-08T09:00:00Z"), fragmented: false, longestFreeMinutes: 300, meetingCount: 1, totalFreeMinutes: 480 }
    ], 60);
    expect(out).toContain("protects focus");
  });
});
