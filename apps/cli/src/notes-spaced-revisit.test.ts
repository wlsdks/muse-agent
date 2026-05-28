import { describe, expect, it } from "vitest";

import { REVISIT_INTERVALS_DAYS, revisitDueInterval, selectNotesForRevisit } from "./commands-notes-rag.js";

describe("revisitDueInterval — spacing effect / Leitner expanding intervals", () => {
  it("is due exactly when the day-age lands on an interval", () => {
    for (const iv of REVISIT_INTERVALS_DAYS) {
      expect(revisitDueInterval(iv)).toBe(iv);
      expect(revisitDueInterval(iv + 0.9)).toBe(iv); // same calendar day → still due
    }
  });

  it("is not due between intervals", () => {
    expect(revisitDueInterval(2)).toBeUndefined();
    expect(revisitDueInterval(4)).toBeUndefined();
    expect(revisitDueInterval(0)).toBeUndefined(); // brand-new note, not yet due
    expect(revisitDueInterval(200)).toBeUndefined(); // past the last interval
  });

  it("rejects negative / non-finite age", () => {
    expect(revisitDueInterval(-1)).toBeUndefined();
    expect(revisitDueInterval(Number.NaN)).toBeUndefined();
    expect(revisitDueInterval(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("selectNotesForRevisit", () => {
  it("keeps only due notes, soonest-interval first (path tiebreak)", () => {
    const due = selectNotesForRevisit([
      { path: "z.md", ageDays: 7.2 }, // due @7
      { path: "a.md", ageDays: 7.0 }, // due @7
      { path: "b.md", ageDays: 1.5 }, // due @1
      { path: "c.md", ageDays: 4.0 } // not due
    ]);
    expect(due.map((d) => `${d.path}:${d.intervalDays.toString()}`)).toEqual(["b.md:1", "a.md:7", "z.md:7"]);
  });

  it("returns nothing when no note is due", () => {
    expect(selectNotesForRevisit([{ path: "x.md", ageDays: 2 }, { path: "y.md", ageDays: 50 }])).toEqual([]);
  });

  it("carries the age through for display", () => {
    const due = selectNotesForRevisit([{ path: "n.md", ageDays: 16.4 }]);
    expect(due[0]).toMatchObject({ path: "n.md", intervalDays: 16 });
    expect(due[0]?.ageDays).toBeCloseTo(16.4, 5);
  });
});
