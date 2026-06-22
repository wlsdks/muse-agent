import { describe, expect, it } from "vitest";

import { detectNoteFamilyAbsence, type NoteActivityEvent } from "../src/note-family-absence.js";

const DAY = 86_400_000;
const now = new Date("2026-06-04T12:00:00Z");
const nowMs = now.getTime();

/** A family with `count` files spaced `gapDays` apart, ending `silentDays` ago. */
function family(name: string, count: number, gapDays: number, silentDays: number): NoteActivityEvent[] {
  const last = nowMs - silentDays * DAY;
  return Array.from({ length: count }, (_, i) => ({
    family: name,
    updatedAtMs: last - (count - 1 - i) * gapDays * DAY
  }));
}

describe("detectNoteFamilyAbsence", () => {
  it("flags a family gone silent past its own cadence baseline", () => {
    // 'project-apollo': 5 files ~4 days apart, last touched 28 days ago.
    const out = detectNoteFamilyAbsence(family("project-apollo", 5, 4, 28), { now });
    expect(out).toHaveLength(1);
    expect(out[0]!.family).toBe("project-apollo");
    expect(out[0]!.fileCount).toBe(5);
    expect(out[0]!.typicalGapDays).toBe(4);
    expect(out[0]!.silentDays).toBe(28);
  });

  it("does NOT flag a family still within its baseline cadence", () => {
    // ~7-day cadence, last touched 5 days ago → not yet stale.
    expect(detectNoteFamilyAbsence(family("journal", 5, 7, 5), { now })).toEqual([]);
  });

  it("does NOT flag a family with too few files to establish a cadence", () => {
    expect(detectNoteFamilyAbsence(family("sparse", 2, 4, 60), { now })).toEqual([]);
  });

  it("respects the absolute silence floor (a fast cadence can't fire on a tiny gap)", () => {
    // ~0.5-day cadence, silent 3 days: 3 > 2.5×0.5 but 3 < the 10-day floor.
    const events = family("rapid", 6, 0.5, 3);
    expect(detectNoteFamilyAbsence(events, { now })).toEqual([]);
    // With a lower floor it WOULD fire (proves the floor is what suppressed it).
    expect(detectNoteFamilyAbsence(events, { now, minSilentDays: 1 })).toHaveLength(1);
  });

  it("skips a family whose files were all touched at once (zero cadence)", () => {
    const sameInstant = nowMs - 40 * DAY;
    expect(detectNoteFamilyAbsence(
      [0, 1, 2, 3].map(() => ({ family: "bulk", updatedAtMs: sameInstant })),
      { now }
    )).toEqual([]);
  });

  it("orders the most-overdue family (vs its own baseline) first and caps to limit", () => {
    const events = [
      ...family("a", 4, 10, 35), // 3.5× its gap
      ...family("b", 4, 2, 30), // 15× its gap — far more overdue
      ...family("c", 4, 5, 20) // 4× its gap
    ];
    const out = detectNoteFamilyAbsence(events, { now, limit: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.family).toBe("b");
  });

  it("ignores empty-named families and non-finite timestamps", () => {
    expect(detectNoteFamilyAbsence([
      { family: "  ", updatedAtMs: nowMs - 50 * DAY },
      { family: "x", updatedAtMs: Number.NaN }
    ], { now })).toEqual([]);
  });
});
