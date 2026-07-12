import { describe, expect, it } from "vitest";

import { classifyPreferenceSlots, isGoalKey, isVetoKey } from "@muse/recall";

describe("isVetoKey / isGoalKey", () => {
  it("matches only the respective prefix", () => {
    expect(isVetoKey("veto:coffee")).toBe(true);
    expect(isVetoKey("goal:ship")).toBe(false);
    expect(isVetoKey("language")).toBe(false);
    expect(isGoalKey("goal:ship")).toBe(true);
    expect(isGoalKey("veto:coffee")).toBe(false);
    expect(isGoalKey("language")).toBe(false);
  });
});

describe("classifyPreferenceSlots", () => {
  it("routes a veto: entry to vetoes with the prefix stripped", () => {
    const { vetoes, plain, goals } = classifyPreferenceSlots({ "veto:coffee": "never again" });
    expect(vetoes).toEqual([["coffee", "never again"]]);
    expect(plain).toEqual([]);
    expect(goals).toEqual([]);
  });

  it("routes a goal: entry to goals with the prefix stripped", () => {
    const { goals, plain, vetoes } = classifyPreferenceSlots({ "goal:ship": "launch v2" });
    expect(goals).toEqual([["ship", "launch v2"]]);
    expect(plain).toEqual([]);
    expect(vetoes).toEqual([]);
  });

  it("keeps a plain key unchanged, in plain", () => {
    const { plain, vetoes, goals } = classifyPreferenceSlots({ language: "Korean" });
    expect(plain).toEqual([["language", "Korean"]]);
    expect(vetoes).toEqual([]);
    expect(goals).toEqual([]);
  });

  it("preserves insertion order within each bucket", () => {
    const { plain, vetoes, goals } = classifyPreferenceSlots({
      "veto:a": "1",
      language: "Korean",
      "goal:x": "2",
      "veto:b": "3",
      length: "cap",
      "goal:y": "4"
    });
    expect(plain.map(([k]) => k)).toEqual(["language", "length"]);
    expect(vetoes.map(([k]) => k)).toEqual(["a", "b"]);
    expect(goals.map(([k]) => k)).toEqual(["x", "y"]);
  });

  it("returns all-empty buckets for empty input", () => {
    const result = classifyPreferenceSlots({});
    expect(result).toEqual({ plain: [], vetoes: [], goals: [] });
  });
});
