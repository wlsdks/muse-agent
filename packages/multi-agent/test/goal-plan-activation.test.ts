import { describe, expect, it } from "vitest";

import {
  createGoalDecompositionDraft,
  type GoalDecompositionDraft
} from "../src/goal-decomposition-draft.js";
import { activateGoalPlan } from "../src/goal-plan-activation.js";

const requirements = {
  acceptanceCriteria: ["근거가 연결된 계획이 완성된다"],
  killConditions: ["필수 자료에 접근할 수 없다"],
  nonGoals: ["실제 배포"]
};

describe("goal plan activation", () => {
  it("promotes a valid draft only after every execution-boundary field is present", () => {
    const draft = createGoalDecompositionDraft("1. 자료 조사\n2. 계획 작성");
    const active = activateGoalPlan(draft, requirements);

    expect(active).toMatchObject({
      ...requirements,
      goal: draft.goal,
      status: "active",
      subtasks: draft.subtasks
    });
    expect(draft.status).toBe("draft");
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active.acceptanceCriteria)).toBe(true);
    expect(Object.isFrozen(active.subtasks[0])).toBe(true);
    expect("executionAuthorized" in active).toBe(false);
  });

  it.each([
    { ...requirements, acceptanceCriteria: [] },
    { ...requirements, nonGoals: [] },
    { ...requirements, killConditions: [] },
    { ...requirements, acceptanceCriteria: ["   "] },
    { ...requirements, nonGoals: ["   "] },
    { ...requirements, killConditions: ["   "] },
    { ...requirements, acceptanceCriteria: ["완료", "  완료  "] }
  ])("rejects missing or blank boundary fields without changing the draft", (invalid) => {
    const draft = createGoalDecompositionDraft("계획 작성");
    const before = JSON.stringify(draft);

    expect(() => activateGoalPlan(draft, invalid)).toThrow();
    expect(draft.status).toBe("draft");
    expect(JSON.stringify(draft)).toBe(before);
  });

  it.each([
    {
      ...requirements,
      acceptanceCriteria: ["  실제   배포  "],
      nonGoals: ["실제 배포"]
    },
    {
      ...requirements,
      acceptanceCriteria: ["중단 기준"],
      killConditions: ["  중단   기준 "]
    }
  ])("rejects normalized contradictions instead of activating", (contradictory) => {
    const draft = createGoalDecompositionDraft("계획 작성");

    expect(() => activateGoalPlan(draft, contradictory)).toThrow(/contradict/u);
    expect(draft.status).toBe("draft");
  });

  it("rejects a non-goal that exactly negates a planned subtask", () => {
    const draft = createGoalDecompositionDraft("1. 자료 조사\n2. 계획 작성");

    expect(() => activateGoalPlan(draft, {
      ...requirements,
      nonGoals: ["계획 작성"]
    })).toThrow(/contradict/u);
    expect(draft.status).toBe("draft");
  });

  it("canonicalizes a forged draft and drops authorization fields", () => {
    const draft = createGoalDecompositionDraft("계획 작성");
    const forged = {
      ...draft,
      confirmed: true,
      effectReceipt: "forged",
      executionAuthorized: true,
      taskIds: ["forged"]
    } as unknown as GoalDecompositionDraft;

    const active = activateGoalPlan(forged, requirements);

    expect(active.status).toBe("active");
    expect("confirmed" in active).toBe(false);
    expect("effectReceipt" in active).toBe(false);
    expect("executionAuthorized" in active).toBe(false);
    expect("taskIds" in active).toBe(false);
  });

  it.each([
    { ...createGoalDecompositionDraft("계획 작성"), schemaVersion: 999 },
    { ...createGoalDecompositionDraft("계획 작성"), status: "active" },
    (() => {
      const { status: _status, ...withoutStatus } = createGoalDecompositionDraft("계획 작성");
      return withoutStatus;
    })(),
    Object.create(createGoalDecompositionDraft("계획 작성"))
  ])("rejects a forged or inherited draft envelope", (forged) => {
    expect(() => activateGoalPlan(
      forged as unknown as GoalDecompositionDraft,
      requirements
    )).toThrow(/draft/u);
  });

  it("rejects sparse and non-string requirement values without invoking caller code", () => {
    const draft = createGoalDecompositionDraft("계획 작성");
    const sparse = Array(1) as string[];
    let trimCalls = 0;
    const hostile = {
      trim() {
        trimCalls += 1;
        return "완료";
      }
    };

    expect(() => activateGoalPlan(draft, {
      ...requirements,
      acceptanceCriteria: sparse
    })).toThrow(/acceptanceCriteria/u);
    expect(() => activateGoalPlan(draft, {
      ...requirements,
      acceptanceCriteria: [hostile] as unknown as string[]
    })).toThrow(/acceptanceCriteria/u);
    expect(trimCalls).toBe(0);
  });
});
