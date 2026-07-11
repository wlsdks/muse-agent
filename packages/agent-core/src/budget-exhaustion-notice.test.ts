import { describe, expect, it } from "vitest";

import { BudgetExhaustionTracker, budgetExhaustionNotice } from "./budget-exhaustion-notice.js";

describe("budgetExhaustionNotice", () => {
  it("names both the used count and the limit as digits", () => {
    const notice = budgetExhaustionNotice(10, 10);
    expect(notice).toContain("10");
    expect(notice.toLowerCase()).toContain("final answer");
  });

  it("names a different used/limit pair correctly", () => {
    const notice = budgetExhaustionNotice(3, 5);
    expect(notice).toContain("3");
    expect(notice).toContain("5");
    expect(notice.toLowerCase()).toContain("final answer");
  });
});

describe("BudgetExhaustionTracker", () => {
  it("consumeNotice returns true exactly once, false thereafter", () => {
    const tracker = new BudgetExhaustionTracker();
    expect(tracker.consumeNotice()).toBe(true);
    expect(tracker.consumeNotice()).toBe(false);
    expect(tracker.consumeNotice()).toBe(false);
  });
});
