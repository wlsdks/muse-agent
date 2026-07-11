import { describe, expect, it } from "vitest";

import {
  browserActionsLabel,
  createBrowserActionBudget,
  guardBrowserAction,
  isBudgetExhausted,
  isBudgetNearCap,
  recordBrowserAction
} from "./browser-action-budget.js";

describe("browser action budget", () => {
  it("bounds a task: allows exactly N actions then refuses the N+1th", () => {
    let budget = createBrowserActionBudget(3);

    for (let action = 1; action <= 3; action += 1) {
      const decision = guardBrowserAction(budget);
      expect(decision.allowed).toBe(true);
      budget = recordBrowserAction(budget);
    }

    const fourth = guardBrowserAction(budget);
    expect(fourth.allowed).toBe(false);
    expect(fourth.refusal).toMatch(/3/);
    expect(fourth.label).toBe("actions_used 3/3");
  });

  it("boundary is exact: used===max is exhausted, used===max-1 is allowed", () => {
    const atCap = { max: 5, used: 5 };
    const oneUnderCap = { max: 5, used: 4 };

    expect(isBudgetExhausted(atCap)).toBe(true);
    expect(guardBrowserAction(atCap).allowed).toBe(false);

    expect(isBudgetExhausted(oneUnderCap)).toBe(false);
    expect(guardBrowserAction(oneUnderCap).allowed).toBe(true);
  });

  it("warns one action before the cap and not before", () => {
    const oneBeforeCap = { max: 10, used: 9 };
    const nearCapDecision = guardBrowserAction(oneBeforeCap);
    expect(nearCapDecision.allowed).toBe(true);
    expect(nearCapDecision.warning).toBeDefined();
    expect(isBudgetNearCap(oneBeforeCap)).toBe(true);

    const wellUnderCap = { max: 10, used: 2 };
    const farDecision = guardBrowserAction(wellUnderCap);
    expect(farDecision.allowed).toBe(true);
    expect(farDecision.warning).toBeUndefined();
    expect(isBudgetNearCap(wellUnderCap)).toBe(false);
  });

  it("formats the transparency label", () => {
    expect(browserActionsLabel({ max: 10, used: 3 })).toBe("actions_used 3/10");
  });

  it("rejects an invalid max", () => {
    expect(() => createBrowserActionBudget(0)).toThrow();
    expect(() => createBrowserActionBudget(-1)).toThrow();
    expect(() => createBrowserActionBudget(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => createBrowserActionBudget(NaN)).toThrow();
    expect(() => createBrowserActionBudget(2.5)).toThrow();
  });
});
