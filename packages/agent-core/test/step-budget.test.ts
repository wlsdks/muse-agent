import { describe, expect, it } from "vitest";

import { StepBudgetTracker } from "../src/step-budget.js";

describe("StepBudgetTracker", () => {
  describe("constructor validation", () => {
    it("rejects maxTokens <= 0 / NaN / Infinity", () => {
      expect(() => new StepBudgetTracker({ maxTokens: 0 })).toThrow(/greater than 0/u);
      expect(() => new StepBudgetTracker({ maxTokens: -5 })).toThrow(/greater than 0/u);
      expect(() => new StepBudgetTracker({ maxTokens: Number.NaN })).toThrow(/greater than 0/u);
      expect(() => new StepBudgetTracker({ maxTokens: Number.POSITIVE_INFINITY })).toThrow(/greater than 0/u);
    });

    it("rejects softLimitPercent outside (0, 100) exclusive", () => {
      expect(() => new StepBudgetTracker({ maxTokens: 100, softLimitPercent: 0 })).toThrow(/softLimitPercent/u);
      expect(() => new StepBudgetTracker({ maxTokens: 100, softLimitPercent: 100 })).toThrow(/softLimitPercent/u);
      expect(() => new StepBudgetTracker({ maxTokens: 100, softLimitPercent: -1 })).toThrow(/softLimitPercent/u);
      expect(() => new StepBudgetTracker({ maxTokens: 100, softLimitPercent: Number.NaN })).toThrow(/softLimitPercent/u);
    });
  });

  describe("trackStep input guards", () => {
    it("rejects a blank step label", () => {
      const t = new StepBudgetTracker({ maxTokens: 100 });
      expect(() => t.trackStep("", 1, 1)).toThrow(/step must not be blank/u);
      expect(() => t.trackStep("   ", 1, 1)).toThrow(/step must not be blank/u);
    });

    it("rejects negative / NaN / Infinity token counts", () => {
      const t = new StepBudgetTracker({ maxTokens: 100 });
      expect(() => t.trackStep("s", -1, 0)).toThrow(/non-negative finite/u);
      expect(() => t.trackStep("s", 0, Number.NaN)).toThrow(/non-negative finite/u);
      expect(() => t.trackStep("s", Number.POSITIVE_INFINITY, 0)).toThrow(/non-negative finite/u);
    });
  });

  describe("status thresholds (exact-boundary semantics)", () => {
    it("returns ok strictly below the soft limit and crosses to soft_limit at the boundary (not above)", () => {
      // maxTokens 100, default soft 80% → softLimit = 80
      const t = new StepBudgetTracker({ maxTokens: 100 });
      expect(t.trackStep("a", 50, 29)).toBe("ok");           // 79 < 80
      expect(t.status()).toBe("ok");
      expect(t.trackStep("b", 1, 0)).toBe("soft_limit");     // 80 == soft
    });

    it("crosses to exhausted at cumulative == maxTokens, not after", () => {
      const t = new StepBudgetTracker({ maxTokens: 50 });
      expect(t.trackStep("a", 49, 0)).toBe("soft_limit");
      expect(t.trackStep("b", 1, 0)).toBe("exhausted");      // exactly 50
      expect(t.isExhausted()).toBe(true);
    });

    it("isExhausted() is FALSE while under budget — a fresh tracker and a soft-limit one are not exhausted", () => {
      // The suite only ever asserted isExhausted() === true; without the false
      // case a `return true` regression (always-exhausted) would stop every agent
      // loop on the first step. Pin both not-yet-exhausted states.
      const fresh = new StepBudgetTracker({ maxTokens: 50 });
      expect(fresh.isExhausted()).toBe(false);
      expect(fresh.trackStep("a", 49, 0)).toBe("soft_limit"); // 49 < 50, soft crossed
      expect(fresh.isExhausted()).toBe(false);                // soft_limit is NOT exhausted
    });

    it("honours a custom softLimitPercent (Math.floor against maxTokens)", () => {
      const t = new StepBudgetTracker({ maxTokens: 200, softLimitPercent: 50 });
      // softLimit = floor(200 * 50 / 100) = 100
      expect(t.trackStep("a", 99, 0)).toBe("ok");
      expect(t.trackStep("b", 1, 0)).toBe("soft_limit");
    });
  });

  describe("accumulation + accessors", () => {
    it("recordToolOutput counts the bytes as input-side accumulation", () => {
      const t = new StepBudgetTracker({ maxTokens: 100 });
      t.recordToolOutput("tool", 30);
      expect(t.totalConsumed()).toBe(30);
      expect(t.remaining()).toBe(70);
    });

    it("remaining clamps at 0 even after overrun", () => {
      const t = new StepBudgetTracker({ maxTokens: 100 });
      t.trackStep("a", 200, 0);
      expect(t.totalConsumed()).toBe(200);
      expect(t.remaining()).toBe(0);
      expect(t.isExhausted()).toBe(true);
    });

    it("history records each step in order with its post-step status", () => {
      const t = new StepBudgetTracker({ maxTokens: 100 });
      t.trackStep("a", 40, 0);
      t.trackStep("b", 41, 0);
      const h = t.history();
      expect(h).toHaveLength(2);
      expect(h[0]).toMatchObject({ step: "a", cumulativeTokens: 40, status: "ok" });
      expect(h[1]).toMatchObject({ step: "b", cumulativeTokens: 81, status: "soft_limit" });
    });
  });
});
