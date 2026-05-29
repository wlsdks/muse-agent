import { describe, expect, it } from "vitest";

import {
  composeUserModelSnapshot,
  effectiveConfidence,
  selectReconfirmableSlots,
  type UserModel,
  type UserModelSlot
} from "../src/index.js";

const NOW = new Date("2026-05-01T00:00:00Z");
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 24 * 60 * 60_000);

function model(slots: readonly UserModelSlot[]): UserModel {
  return {
    goals: slots.filter((s): s is Extract<UserModelSlot, { kind: "goal" }> => s.kind === "goal"),
    preferences: slots.filter((s): s is Extract<UserModelSlot, { kind: "preference" }> => s.kind === "preference"),
    schedule: slots.filter((s): s is Extract<UserModelSlot, { kind: "schedule" }> => s.kind === "schedule"),
    vetoes: slots.filter((s): s is Extract<UserModelSlot, { kind: "veto" }> => s.kind === "veto")
  };
}

describe("effectiveConfidence", () => {
  it("asserted slots (no stored confidence) never decay → 1", () => {
    expect(effectiveConfidence(undefined, daysAgo(3650), NOW)).toBe(1);
    expect(effectiveConfidence(Number.NaN, daysAgo(1), NOW)).toBe(1);
  });

  it("inferred confidence halves every halfLifeDays and clamps a future stamp to age 0", () => {
    expect(effectiveConfidence(0.8, NOW, NOW, 30)).toBeCloseTo(0.8, 5); // fresh → undecayed
    expect(effectiveConfidence(0.8, daysAgo(30), NOW, 30)).toBeCloseTo(0.4, 5); // one half-life
    expect(effectiveConfidence(0.8, daysAgo(60), NOW, 30)).toBeCloseTo(0.2, 5); // two half-lives
    expect(effectiveConfidence(0.8, new Date(NOW.getTime() + 5 * 86_400_000), NOW, 30)).toBeCloseTo(0.8, 5); // future → age 0
  });
});

describe("selectReconfirmableSlots", () => {
  it("returns only inferred slots faded below the threshold, most-faded first; asserted excluded", () => {
    const slots: UserModelSlot[] = [
      { confidence: 0.8, id: "fresh", kind: "preference", updatedAt: NOW, value: "bullet points" }, // 0.8 → above
      { confidence: 0.8, id: "stale", kind: "preference", updatedAt: daysAgo(60), value: "dark mode" }, // 0.2 → below 0.35
      { confidence: 0.5, id: "older", kind: "schedule", updatedAt: daysAgo(90), value: "journal at 7", recurrence: "daily" }, // ~0.06 → below
      { id: "asserted", kind: "preference", updatedAt: daysAgo(9999), value: "always Korean" } // no confidence → never
    ];
    const faded = selectReconfirmableSlots(model(slots), { now: NOW });
    expect(faded.map((f) => f.slot.id)).toEqual(["older", "stale"]); // most-faded first
    expect(faded.every((f) => f.effectiveConfidence < 0.35)).toBe(true);
  });

  it("honours a custom reconfirmBelow threshold", () => {
    const slots: UserModelSlot[] = [{ confidence: 0.8, id: "a", kind: "preference", updatedAt: daysAgo(30), value: "x" }]; // 0.4
    expect(selectReconfirmableSlots(model(slots), { now: NOW, reconfirmBelow: 0.35 })).toHaveLength(0);
    expect(selectReconfirmableSlots(model(slots), { now: NOW, reconfirmBelow: 0.5 })).toHaveLength(1);
  });
});

describe("composeUserModelSnapshot — decay gate", () => {
  it("drops a faded inferred preference but keeps an asserted one and a faded veto (safety)", () => {
    const slots: UserModelSlot[] = [
      { confidence: 0.8, id: "stale", kind: "preference", updatedAt: daysAgo(90), value: "dark mode" }, // faded → drop
      { id: "asserted", kind: "preference", updatedAt: daysAgo(90), value: "concise" }, // asserted → keep
      { confidence: 0.8, id: "allergy", kind: "veto", updatedAt: daysAgo(90), scope: "food", value: "no eggs" } // faded but veto → keep
    ];
    const out = composeUserModelSnapshot(model(slots), { confidenceFloor: 0.2, now: NOW });
    expect(out).toContain("pref.asserted=concise");
    expect(out).toContain("veto.food.allergy=no eggs");
    expect(out).not.toContain("dark mode");
  });

  it("without `now` (back-compat) nothing is decay-dropped", () => {
    const slots: UserModelSlot[] = [{ confidence: 0.8, id: "stale", kind: "preference", updatedAt: daysAgo(9999), value: "dark mode" }];
    expect(composeUserModelSnapshot(model(slots), {})).toContain("dark mode");
  });
});
