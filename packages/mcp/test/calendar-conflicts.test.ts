import { describe, expect, it } from "vitest";

import { detectCalendarConflicts, type ConflictEventLike } from "../src/index.js";

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
