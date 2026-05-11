import { describe, expect, it } from "vitest";

import {
  applyToolOutputImportance,
  scoreToolOutputImportance
} from "../src/tool-output-importance.js";

describe("scoreToolOutputImportance (D5)", () => {
  it("boosts personal-data domains above neutral", () => {
    expect(scoreToolOutputImportance("muse.calendar.upcoming")).toBeGreaterThan(1);
    expect(scoreToolOutputImportance("muse.tasks.list")).toBeGreaterThan(1);
    expect(scoreToolOutputImportance("muse.notes.search")).toBeGreaterThan(1);
  });

  it("demotes generic web / fetch tools below neutral", () => {
    expect(scoreToolOutputImportance("muse.web.fetch")).toBeLessThan(1);
    expect(scoreToolOutputImportance("muse.fetch.get")).toBeLessThan(1);
  });

  it("returns neutral 1.0 for unknown tools", () => {
    expect(scoreToolOutputImportance("plugin.random")).toBe(1);
    expect(scoreToolOutputImportance("muse.unknown.op")).toBe(1);
  });

  it("recognises the `<domain>-multi` provider-registry variants (iter 39)", () => {
    // `muse.tasks-multi.*`, `muse.calendar-multi.*`, `muse.notes-multi.*`
    // are the registry-backed siblings of `muse.tasks.*` etc. They surface
    // the same personal-data semantics — a meeting list out of
    // `muse.calendar-multi.upcoming` is just as valuable as the same list
    // out of `muse.calendar.upcoming`. Pre-iter-39 the prefix matcher
    // only recognised `muse.<domain>.` followed by a `.`, so the multi-
    // provider tools fell through to the neutral 1.0 weight and their
    // outputs got trimmed against the same uniform cap as a generic web
    // fetch.
    expect(scoreToolOutputImportance("muse.tasks-multi.list")).toBeGreaterThan(1);
    expect(scoreToolOutputImportance("muse.calendar-multi.upcoming")).toBeGreaterThan(1);
    expect(scoreToolOutputImportance("muse.notes-multi.search")).toBeGreaterThan(1);
    // Same elevated weight as the non-multi variants (1.4 / 1.5).
    expect(scoreToolOutputImportance("muse.tasks-multi.create")).toBe(
      scoreToolOutputImportance("muse.tasks.create")
    );
  });
});

describe("applyToolOutputImportance", () => {
  it("scales the base maxChars by the score", () => {
    expect(applyToolOutputImportance(1_000, 1.5)).toBe(1_500);
    expect(applyToolOutputImportance(1_000, 0.6)).toBe(600);
  });

  it("clamps wildly large scores to 2x", () => {
    expect(applyToolOutputImportance(1_000, 10)).toBe(2_000);
  });

  it("clamps tiny scores to 0.4x", () => {
    expect(applyToolOutputImportance(1_000, 0.01)).toBe(400);
  });

  it("enforces a 64-char floor so tiny budgets stay usable", () => {
    expect(applyToolOutputImportance(50, 0.5)).toBeGreaterThanOrEqual(64);
  });

  it("passes through unchanged when base is 0 or score is invalid", () => {
    expect(applyToolOutputImportance(0, 1.5)).toBe(0);
    expect(applyToolOutputImportance(1_000, Number.NaN)).toBe(1_000);
  });
});
