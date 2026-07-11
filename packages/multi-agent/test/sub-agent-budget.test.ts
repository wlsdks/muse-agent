import { describe, expect, it } from "vitest";
import { resolveSubAgentToolBudget, SUB_AGENT_MIN_BUDGET, SUB_AGENT_UNCAPPED_DEFAULT } from "../src/index.js";

describe("resolveSubAgentToolBudget", () => {
  it("halves a capped parent budget", () => {
    expect(resolveSubAgentToolBudget(10)).toBe(5);
  });

  it("floors a small parent budget to the usable minimum instead of rounding down further", () => {
    expect(resolveSubAgentToolBudget(4)).toBe(3);
  });

  it("never returns below the minimum even for a tiny parent budget", () => {
    expect(resolveSubAgentToolBudget(2)).toBe(3);
  });

  it("gives an uncapped parent a fixed default, never 'unlimited'", () => {
    expect(resolveSubAgentToolBudget(undefined)).toBe(SUB_AGENT_UNCAPPED_DEFAULT);
  });

  it("treats a non-finite or non-positive parent input as uncapped rather than 0/negative/NaN", () => {
    expect(resolveSubAgentToolBudget(0)).toBe(SUB_AGENT_UNCAPPED_DEFAULT);
    expect(resolveSubAgentToolBudget(-5)).toBe(SUB_AGENT_UNCAPPED_DEFAULT);
    expect(resolveSubAgentToolBudget(NaN)).toBe(SUB_AGENT_UNCAPPED_DEFAULT);
    expect(resolveSubAgentToolBudget(Infinity)).toBe(SUB_AGENT_UNCAPPED_DEFAULT);
  });

  it("never returns a value below the documented minimum", () => {
    for (const parent of [1, 2, 3, 4, 5, 6]) {
      expect(resolveSubAgentToolBudget(parent)).toBeGreaterThanOrEqual(SUB_AGENT_MIN_BUDGET);
    }
  });
});
