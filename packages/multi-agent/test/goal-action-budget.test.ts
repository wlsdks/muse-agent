import { describe, expect, it } from "vitest";

import { assessGoalActionBudget } from "../src/goal-action-budget.js";

const LIMITS = {
  attempts: 3,
  effects: 2,
  modelCalls: 4,
  toolCalls: 5,
  wallTimeMs: 60_000
};

const ZERO_USAGE = {
  attempts: 0,
  effects: 0,
  modelCalls: 0,
  toolCalls: 0,
  wallTimeMs: 0
};

describe("goal action budget", () => {
  it("projects remaining capacity while every dimension is below its cap", () => {
    expect(assessGoalActionBudget({
      actionId: "research",
      limits: LIMITS,
      usage: { attempts: 1, effects: 1, modelCalls: 2, toolCalls: 3, wallTimeMs: 10_000 }
    })).toEqual({
      decision: "within-budget",
      remaining: { attempts: 2, effects: 1, modelCalls: 2, toolCalls: 2, wallTimeMs: 50_000 }
    });
  });

  it.each(Object.keys(LIMITS) as Array<keyof typeof LIMITS>)(
    "turns exact %s exhaustion into no-progress terminal state",
    (dimension) => {
      const result = assessGoalActionBudget({
        actionId: "research",
        limits: LIMITS,
        usage: { ...ZERO_USAGE, [dimension]: LIMITS[dimension] }
      });

      expect(result).toMatchObject({
        decision: "terminal",
        exhausted: [dimension],
        terminal: {
          actionId: "research",
          status: "no-progress"
        }
      });
      expect(result.decision === "terminal" && result.terminal.blocker).toContain(dimension);
      expect(result.decision === "terminal" && result.terminal.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect("success" in result).toBe(false);
    }
  );

  it("records every exhausted dimension in fixed order, including overshoot", () => {
    const result = assessGoalActionBudget({
      actionId: "research",
      limits: LIMITS,
      usage: {
        attempts: 4,
        effects: 2,
        modelCalls: 4,
        toolCalls: 6,
        wallTimeMs: 60_001
      }
    });

    expect(result.decision === "terminal" && result.exhausted).toEqual([
      "attempts",
      "wallTimeMs",
      "toolCalls",
      "modelCalls",
      "effects"
    ]);
  });

  it.each([
    { ...LIMITS, attempts: 0 },
    { ...LIMITS, effects: -1 },
    { ...LIMITS, modelCalls: 1.5 },
    { ...LIMITS, toolCalls: Number.MAX_SAFE_INTEGER + 1 },
    { ...LIMITS, wallTimeMs: Number.POSITIVE_INFINITY }
  ])("fails closed on malformed limits", (limits) => {
    expect(() => assessGoalActionBudget({
      actionId: "research",
      limits,
      usage: ZERO_USAGE
    })).toThrow();
  });

  it("rejects extra authority fields and leaves inputs unchanged", () => {
    const input = {
      actionId: "research",
      executionAuthorized: true,
      limits: LIMITS,
      usage: ZERO_USAGE
    };
    const before = JSON.stringify(input);

    expect(() => assessGoalActionBudget(
      input as Parameters<typeof assessGoalActionBudget>[0]
    )).toThrow(/shape/u);
    expect(JSON.stringify(input)).toBe(before);
  });
});
