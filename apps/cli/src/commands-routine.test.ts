import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityPath, computeRoutine } from "./commands-routine.js";

const row = (tsIso: string, userId = "u", kind = "ask"): { tsIso: string; userId: string; kind: string } => ({
  kind,
  tsIso,
  userId
});

describe("computeRoutine", () => {
  it("returns zero counters for an empty activity log", () => {
    expect(computeRoutine([])).toEqual({
      totalSessions: 0,
      daysObserved: 0,
      topHours: [],
      topDays: [],
      sessionsPerDay: 0
    });
  });

  it("aggregates valid rows into hour / day-of-week / day-count buckets", () => {
    // Three distinct UTC days, varied hours; UTC dates are stable
    // regardless of host TZ for the daysObserved assertion.
    const rows = [
      row("2026-05-18T09:00:00Z"),
      row("2026-05-18T15:00:00Z"),
      row("2026-05-19T09:00:00Z"),
      row("2026-05-20T09:00:00Z")
    ];
    const s = computeRoutine(rows);
    expect(s.totalSessions).toBe(4);
    expect(s.daysObserved).toBe(3);
    expect(s.sessionsPerDay).toBe(Number((4 / 3).toFixed(2)));
    expect(s.topHours.length).toBeGreaterThan(0);
    expect(s.topDays.length).toBeGreaterThan(0);
  });

  it("malformed rows are skipped from EVERY counter, keeping `total / days = avg` arithmetically consistent", () => {
    const rows = [
      row("2026-05-18T09:00:00Z"),
      row("not-a-date"),               // skipped
      row(""),                          // skipped
      row("2026-05-19T09:00:00Z"),
      row("garbage")                    // skipped
    ];
    const s = computeRoutine(rows);
    expect(s.totalSessions).toBe(2);
    expect(s.daysObserved).toBe(2);
    expect(s.sessionsPerDay).toBe(1);
    expect(s.totalSessions / s.daysObserved).toBeCloseTo(s.sessionsPerDay, 2);
  });

  it("daysObserved counts unique UTC days (not multi-counted by hour)", () => {
    const rows = [
      row("2026-05-18T01:00:00Z"),
      row("2026-05-18T13:00:00Z"),
      row("2026-05-18T23:00:00Z")
    ];
    const s = computeRoutine(rows);
    expect(s.totalSessions).toBe(3);
    expect(s.daysObserved).toBe(1);
    expect(s.sessionsPerDay).toBe(3);
  });
});

describe("activityPath — empty MUSE_ACTIVITY_FILE= no longer shadows the default", () => {
  beforeEach(() => {
    vi.stubEnv("MUSE_ACTIVITY_FILE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats an empty / whitespace-only env value as unset (falls back to ~/.muse/activity.jsonl)", () => {
    vi.stubEnv("MUSE_ACTIVITY_FILE", "");
    expect(activityPath()).toMatch(/\.muse[/\\]activity\.jsonl$/u);
    vi.stubEnv("MUSE_ACTIVITY_FILE", "   ");
    expect(activityPath()).toMatch(/\.muse[/\\]activity\.jsonl$/u);
  });

  it("uses the env value when it is a non-empty trimmed path", () => {
    vi.stubEnv("MUSE_ACTIVITY_FILE", "  /tmp/custom-activity.jsonl  ");
    expect(activityPath()).toBe("/tmp/custom-activity.jsonl");
  });
});
