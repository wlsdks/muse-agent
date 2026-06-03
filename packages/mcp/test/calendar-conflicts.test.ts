import { describe, expect, it } from "vitest";

import { detectCalendarConflicts, selectUpcomingConflicts, type ConflictEventLike } from "../src/index.js";

const ev = (title: string, start: string, end: string): ConflictEventLike => ({
  title,
  startsAt: new Date(start),
  endsAt: new Date(end)
});

describe("detectCalendarConflicts", () => {
  it("reports an overlapping pair with the overlap span", () => {
    const conflicts = detectCalendarConflicts([
      ev("review", "2026-05-27T15:00:00Z", "2026-05-27T16:00:00Z"),
      ev("call", "2026-05-27T15:30:00Z", "2026-05-27T16:30:00Z")
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.a.title).toBe("review");
    expect(conflicts[0]?.b.title).toBe("call");
    expect(conflicts[0]?.overlapStartsAt.toISOString()).toBe("2026-05-27T15:30:00.000Z");
    expect(conflicts[0]?.overlapEndsAt.toISOString()).toBe("2026-05-27T16:00:00.000Z");
  });

  it("does NOT flag back-to-back events (end == next start)", () => {
    expect(detectCalendarConflicts([
      ev("a", "2026-05-27T15:00:00Z", "2026-05-27T16:00:00Z"),
      ev("b", "2026-05-27T16:00:00Z", "2026-05-27T17:00:00Z")
    ])).toEqual([]);
  });

  it("flags a fully-nested event", () => {
    const conflicts = detectCalendarConflicts([
      ev("outer", "2026-05-27T09:00:00Z", "2026-05-27T12:00:00Z"),
      ev("inner", "2026-05-27T10:00:00Z", "2026-05-27T11:00:00Z")
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.overlapStartsAt.toISOString()).toBe("2026-05-27T10:00:00.000Z");
    expect(conflicts[0]?.overlapEndsAt.toISOString()).toBe("2026-05-27T11:00:00.000Z");
  });

  it("reports all pairs when three events mutually overlap", () => {
    const conflicts = detectCalendarConflicts([
      ev("a", "2026-05-27T15:00:00Z", "2026-05-27T16:30:00Z"),
      ev("b", "2026-05-27T15:30:00Z", "2026-05-27T17:00:00Z"),
      ev("c", "2026-05-27T16:00:00Z", "2026-05-27T16:15:00Z")
    ]);
    // a-b, a-c, b-c
    expect(conflicts).toHaveLength(3);
  });

  it("returns [] for non-overlapping, single, or empty input", () => {
    expect(detectCalendarConflicts([])).toEqual([]);
    expect(detectCalendarConflicts([ev("solo", "2026-05-27T09:00:00Z", "2026-05-27T10:00:00Z")])).toEqual([]);
    expect(detectCalendarConflicts([
      ev("a", "2026-05-27T09:00:00Z", "2026-05-27T10:00:00Z"),
      ev("b", "2026-05-27T11:00:00Z", "2026-05-27T12:00:00Z")
    ])).toEqual([]);
  });

  it("skips zero/negative-duration and unparseable-time events", () => {
    expect(detectCalendarConflicts([
      ev("zero", "2026-05-27T15:00:00Z", "2026-05-27T15:00:00Z"),
      ev("real", "2026-05-27T15:00:00Z", "2026-05-27T16:00:00Z"),
      ev("bad", "not-a-date", "also-bad")
    ])).toEqual([]);
  });
});

describe("selectUpcomingConflicts — the proactive-notice layer (future clashes within a window)", () => {
  const now = new Date("2026-05-27T09:00:00Z");

  it("surfaces a future double-booking with a stable key and a local-time line", () => {
    const notices = selectUpcomingConflicts([
      ev("review", "2026-05-29T15:00:00Z", "2026-05-29T16:00:00Z"),
      ev("call", "2026-05-29T15:30:00Z", "2026-05-29T16:30:00Z")
    ], { now, withinDays: 7 });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.key).toContain("review@2026-05-29T15:00:00.000Z");
    expect(notices[0]?.key).toContain("call@2026-05-29T15:30:00.000Z");
    // line names both events; times rendered in local tz (not the UTC ISO).
    expect(notices[0]?.line).toContain("review");
    expect(notices[0]?.line).toContain("call");
    expect(notices[0]?.line).toMatch(/AM|PM/u);
    expect(notices[0]?.line).not.toContain("T15:00");
  });

  it("EXCLUDES a clash already underway or in the past (only upcoming clashes nag)", () => {
    // overlap began before `now` ⇒ not actionable, dropped.
    expect(selectUpcomingConflicts([
      ev("a", "2026-05-27T08:00:00Z", "2026-05-27T10:00:00Z"),
      ev("b", "2026-05-27T08:30:00Z", "2026-05-27T09:30:00Z")
    ], { now, withinDays: 7 })).toEqual([]);
  });

  it("EXCLUDES a clash beyond the horizon window", () => {
    expect(selectUpcomingConflicts([
      ev("a", "2026-06-30T15:00:00Z", "2026-06-30T16:00:00Z"),
      ev("b", "2026-06-30T15:30:00Z", "2026-06-30T16:30:00Z")
    ], { now, withinDays: 7 })).toEqual([]);
  });

  it("orders multiple notices soonest-first", () => {
    const notices = selectUpcomingConflicts([
      ev("late-a", "2026-05-31T15:00:00Z", "2026-05-31T16:00:00Z"),
      ev("late-b", "2026-05-31T15:30:00Z", "2026-05-31T16:30:00Z"),
      ev("soon-a", "2026-05-28T10:00:00Z", "2026-05-28T11:00:00Z"),
      ev("soon-b", "2026-05-28T10:30:00Z", "2026-05-28T11:30:00Z")
    ], { now, withinDays: 7 });
    expect(notices).toHaveLength(2);
    expect(notices[0]?.line).toContain("soon-a");
    expect(notices[1]?.line).toContain("late-a");
  });

  it("returns [] when there are no conflicts at all", () => {
    expect(selectUpcomingConflicts([
      ev("a", "2026-05-28T09:00:00Z", "2026-05-28T10:00:00Z"),
      ev("b", "2026-05-28T11:00:00Z", "2026-05-28T12:00:00Z")
    ], { now, withinDays: 7 })).toEqual([]);
  });
});
