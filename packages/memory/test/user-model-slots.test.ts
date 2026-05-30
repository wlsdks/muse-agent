import { describe, expect, it } from "vitest";

import {
  EMPTY_USER_MODEL,
  composeUserModelSnapshot,
  effectiveConfidence,
  removeUserModelSlot,
  selectReconfirmableSlots,
  upsertUserModelSlot,
  type UserModel,
  type UserModelSlot
} from "../src/user-model-slots.js";

// Direct coverage for the typed user-model slots (untested module) — the
// persistent, structured model of who the user is (preferences / schedule /
// vetoes / goals). Core to Muse's "it's actually yours" identity, and the
// confidence-decay math is load-bearing: a guess Muse made months ago must
// fade so it stops dominating the persona, while an ASSERTED fact and a VETO
// (a safety "don't") must never silently decay away. All pure known-answer.

const t0 = new Date("2026-01-01T00:00:00Z");
const slot = (kind: UserModelSlot["kind"], id: string, value: string, extra: Record<string, unknown> = {}): UserModelSlot =>
  ({ id, kind, updatedAt: t0, value, ...extra }) as UserModelSlot;

describe("effectiveConfidence", () => {
  it("an ASSERTED slot (no stored confidence) never decays — always 1", () => {
    expect(effectiveConfidence(undefined, t0, new Date("2026-06-01T00:00:00Z"))).toBe(1);
  });

  it("an INFERRED confidence decays exponentially: 0.8 halves to 0.4 over one half-life", () => {
    expect(effectiveConfidence(0.8, t0, new Date("2026-01-31T00:00:00Z"), 30)).toBeCloseTo(0.4, 10);
  });

  it("clamps a stored confidence to [0,1], treats a future timestamp as age 0, and defaults a non-positive half-life", () => {
    const sameInstant = new Date("2026-01-31T00:00:00Z");
    expect(effectiveConfidence(5, sameInstant, sameInstant, 30)).toBe(1); // clamped to 1, age 0
    expect(effectiveConfidence(0.8, new Date("2026-02-10T00:00:00Z"), sameInstant, 30)).toBe(0.8); // future → no boost
    expect(effectiveConfidence(0.8, t0, new Date("2026-01-31T00:00:00Z"), 0)).toBeCloseTo(0.4, 10); // half-life 0 → default 30
  });
});

describe("upsertUserModelSlot / removeUserModelSlot", () => {
  it("replaces a slot by id within its kind (no duplicate) and is pure", () => {
    const first = upsertUserModelSlot(EMPTY_USER_MODEL, slot("preference", "p1", "concise", { category: "style", confidence: 0.8 }));
    const second = upsertUserModelSlot(first, slot("preference", "p1", "very concise", { category: "style", confidence: 0.9 }));
    expect(second.preferences).toHaveLength(1);
    expect(second.preferences[0]?.value).toBe("very concise");
    expect(EMPTY_USER_MODEL.preferences).toHaveLength(0); // original untouched
  });

  it("routes each kind into its own array and removes by id from whichever kind holds it", () => {
    let model: UserModel = EMPTY_USER_MODEL;
    model = upsertUserModelSlot(model, slot("veto", "v1", "no eggs", { scope: "food" }));
    model = upsertUserModelSlot(model, slot("goal", "g1", "ship v1"));
    expect(model.vetoes).toHaveLength(1);
    expect(model.goals).toHaveLength(1);
    const removed = removeUserModelSlot(model, "v1");
    expect(removed.vetoes).toHaveLength(0);
    expect(removed.goals).toHaveLength(1); // unrelated kind untouched
  });
});

describe("selectReconfirmableSlots", () => {
  it("returns only INFERRED slots whose effective confidence faded below the threshold, most-faded first, never asserted/veto", () => {
    let model: UserModel = EMPTY_USER_MODEL;
    model = upsertUserModelSlot(model, slot("preference", "p1", "concise", { confidence: 0.9 })); // inferred → fades
    model = upsertUserModelSlot(model, slot("preference", "p2", "formal", { confidence: 0.3 })); // inferred, fades faster
    model = upsertUserModelSlot(model, slot("veto", "v1", "no eggs")); // asserted (no confidence) → never reconfirmable
    const reconfirm = selectReconfirmableSlots(model, { now: new Date("2026-05-01T00:00:00Z") }); // ~+120d
    expect(reconfirm.map((e) => e.slot.id)).toEqual(["p2", "p1"]); // most-faded (lower confidence) first
    expect(reconfirm.some((e) => e.slot.kind === "veto")).toBe(false);
    expect(reconfirm[0]?.effectiveConfidence).toBeLessThan(reconfirm[1]?.effectiveConfidence ?? 1);
  });

  it("returns nothing when no inferred slot has faded below the threshold", () => {
    const model = upsertUserModelSlot(EMPTY_USER_MODEL, slot("preference", "p1", "concise", { confidence: 0.9 }));
    expect(selectReconfirmableSlots(model, { now: t0 })).toEqual([]); // fresh → confidence 0.9 ≥ 0.35
  });
});

describe("composeUserModelSnapshot", () => {
  const fullModel = (): UserModel => {
    let model: UserModel = EMPTY_USER_MODEL;
    model = upsertUserModelSlot(model, slot("preference", "p1", "concise", { category: "style", confidence: 0.9 }));
    model = upsertUserModelSlot(model, slot("veto", "v1", "no eggs", { scope: "food" }));
    model = upsertUserModelSlot(model, slot("schedule", "s1", "wake", { recurrence: "daily 07:00 KST" }));
    model = upsertUserModelSlot(model, slot("goal", "g1", "ship v1", { dueAt: new Date("2026-03-01T00:00:00Z"), progress: 0.5 }));
    return model;
  };

  it("returns undefined for an empty model", () => {
    expect(composeUserModelSnapshot(EMPTY_USER_MODEL)).toBeUndefined();
  });

  it("composes a single line with vetoes FIRST and each kind's decorators", () => {
    expect(composeUserModelSnapshot(fullModel()))
      .toBe("veto.food.v1=no eggs; pref.style.p1=concise; sched.s1=wake (daily 07:00 KST); goal.g1=ship v1 (50%, due 2026-03-01)");
  });

  it("decay-gate drops a faded inferred preference but KEEPS the veto (safety) and asserted slots", () => {
    const gated = composeUserModelSnapshot(fullModel(), { confidenceFloor: 0.35, now: new Date("2026-05-01T00:00:00Z") });
    expect(gated).toContain("veto.food.v1=no eggs"); // safety constraint never decay-dropped
    expect(gated).toContain("sched.s1=wake"); // asserted (no confidence) survives
    expect(gated).not.toContain("pref.style.p1"); // faded inferred preference dropped
  });
});
