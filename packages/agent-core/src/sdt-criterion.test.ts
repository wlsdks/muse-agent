import { describe, expect, it } from "vitest";

import { adjustConfidenceFloor, sdtCriterion, summarizeNoticeResponses } from "./sdt-criterion.js";

describe("sdtCriterion (Green & Swets likelihood-ratio criterion)", () => {
  it("a dismiss-heavy category yields beta > 1 (suppress more), an acted-heavy one < 1", () => {
    expect(sdtCriterion({ acted: 1, dismissed: 9 })).toBeGreaterThan(1);
    expect(sdtCriterion({ acted: 9, dismissed: 1 })).toBeLessThan(1);
    expect(sdtCriterion({ acted: 5, dismissed: 5 })).toBeCloseTo(1, 5);
  });

  it("cost asymmetry shifts the criterion and the result is bounded", () => {
    const missCostly = sdtCriterion({ acted: 5, costMiss: 4, dismissed: 5 });
    expect(missCostly).toBeLessThan(1);
    expect(sdtCriterion({ acted: 0, dismissed: 1000 })).toBeLessThanOrEqual(4);
    expect(sdtCriterion({ acted: 1000, dismissed: 0 })).toBeGreaterThanOrEqual(0.25);
  });
});

describe("adjustConfidenceFloor", () => {
  it("raises the floor for a dismissive user, lowers it for a receptive one, identity at beta=1", () => {
    expect(adjustConfidenceFloor(0.7, 2)).toBeCloseTo(0.85, 5);
    expect(adjustConfidenceFloor(0.7, 0.5)).toBeCloseTo(0.4, 5);
    expect(adjustConfidenceFloor(0.7, 1)).toBeCloseTo(0.7, 5);
    expect(adjustConfidenceFloor(0.7, 1000)).toBeLessThanOrEqual(0.95);
  });

  it("never returns NaN — a non-finite/non-positive beta falls back to the base floor (gate stays usable)", () => {
    // beta=0 with baseFloor=1 is 0/0 → NaN in the naive formula; a NaN floor
    // silently disables the gate, so it must fall back instead.
    for (const beta of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = adjustConfidenceFloor(1, beta);
      expect(Number.isFinite(out)).toBe(true);
      expect(out).toBeGreaterThanOrEqual(0.05);
      expect(out).toBeLessThanOrEqual(0.95);
    }
    // a non-finite baseFloor is also coerced to a usable number, never NaN
    expect(Number.isFinite(adjustConfidenceFloor(Number.NaN, 2))).toBe(true);
  });
});

describe("summarizeNoticeResponses", () => {
  it("counts done+snooze as acted and dismiss as noise, per kind", () => {
    const stats = summarizeNoticeResponses([
      { kind: "pattern", text: "↩ user: done" },
      { kind: "pattern", text: "↩ user: dismiss" },
      { kind: "pattern", text: "↩ user: dismiss" },
      { kind: "reminder", text: "↩ user: snooze 30m" },
      { kind: "pattern", text: "task heads-up fired" }
    ]);
    expect(stats.get("pattern")).toEqual({ acted: 1, dismissed: 2 });
    expect(stats.get("reminder")).toEqual({ acted: 1, dismissed: 0 });
  });
});
