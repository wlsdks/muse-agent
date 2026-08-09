import { describe, expect, it } from "vitest";

import {
  canonicalFollowupRecurrenceJson,
  followupCommitmentKey,
  nextFollowupOccurrence,
  normalizeFollowupRecurrence
} from "../src/followup-recurrence.js";

const local = (year: number, month: number, day: number, hour: number, minute = 0): Date =>
  new Date(year, month - 1, day, hour, minute, 0, 0);

describe("follow-up recurrence contract", () => {
  it("uses strict-after wall-clock math for daily and weekdays", () => {
    const daily = { kind: "daily" as const, hour: 9, minute: 0 };
    expect(nextFollowupOccurrence(local(2026, 5, 13, 9), daily)).toEqual(local(2026, 5, 14, 9));
    expect(nextFollowupOccurrence(local(2026, 5, 13, 8, 59), daily)).toEqual(local(2026, 5, 13, 9));

    const weekdays = { kind: "weekdays" as const, hour: 9, minute: 0 };
    expect(nextFollowupOccurrence(local(2026, 5, 15, 10), weekdays)).toEqual(local(2026, 5, 18, 9));
  });

  it("resolves explicit weekly, monthly, and nth-weekday rules", () => {
    expect(nextFollowupOccurrence(local(2026, 5, 13, 10), {
      kind: "weekly", weekday: 1, hour: 8, minute: 30
    })).toEqual(local(2026, 5, 18, 8, 30));
    expect(nextFollowupOccurrence(local(2026, 5, 31, 10), {
      kind: "monthly", dayOfMonth: 31, hour: 8, minute: 0
    })).toEqual(local(2026, 7, 31, 8));
    expect(nextFollowupOccurrence(local(2026, 5, 1, 10), {
      kind: "nth-weekday", ordinal: 5, weekday: 1, hour: 8, minute: 0
    })).toEqual(local(2026, 6, 29, 8));
  });

  it("normalizes only the canonical vocabulary and makes stable keys", () => {
    const recurrence = normalizeFollowupRecurrence({ kind: "weekly", weekday: 1, hour: 8, minute: 5 });
    expect(recurrence).toEqual({ kind: "weekly", weekday: 1, hour: 8, minute: 5 });
    expect(normalizeFollowupRecurrence({ kind: "monthly", dayOfMonth: 32, hour: 8, minute: 0 })).toBeUndefined();
    expect(canonicalFollowupRecurrenceJson(recurrence)).toBe("{\"kind\":\"weekly\",\"weekday\":1,\"hour\":8,\"minute\":5}");
    expect(followupCommitmentKey("u", "  Check Q3 memo! ", recurrence))
      .toBe(followupCommitmentKey("u", "check q3 memo", { kind: "weekly", weekday: 1, hour: 8, minute: 5 }));
  });
});
