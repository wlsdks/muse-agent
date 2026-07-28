import { describe, expect, it } from "vitest";

import { selectNextReadyGoalAction } from "../src/goal-action-selector.js";
import { createGoalDecompositionDraft, reviseGoalDecompositionDraft } from "../src/goal-decomposition-draft.js";
import { activateGoalPlan } from "../src/goal-plan-activation.js";

function plan() {
  const draft = reviseGoalDecompositionDraft(
    createGoalDecompositionDraft("계획 실행"),
    {
      subtasks: [
        { dependsOn: [], id: "research", title: "자료 조사" },
        { dependsOn: ["research"], id: "draft", title: "초안 작성" },
        { dependsOn: [], id: "review", title: "독립 검토" }
      ]
    }
  );
  return activateGoalPlan(draft, {
    acceptanceCriteria: ["근거 있는 계획"],
    killConditions: ["자료 접근 불가"],
    nonGoals: ["실제 배포"]
  });
}

describe("selectNextReadyGoalAction", () => {
  it("returns exactly the first dependency-ready action in plan order", () => {
    const active = plan();
    const selected = selectNextReadyGoalAction(active, {
      completedSubtaskIds: ["research"],
      missingAuthoritySubtaskIds: [],
      ownerDecisionSubtaskIds: []
    });

    expect(selected).toEqual(active.subtasks[1]);
  });

  it("excludes unmet dependencies, owner decisions, missing authority, and completed actions", () => {
    const active = plan();

    expect(selectNextReadyGoalAction(active, {
      completedSubtaskIds: [],
      missingAuthoritySubtaskIds: ["review"],
      ownerDecisionSubtaskIds: ["research"]
    })).toBeUndefined();
    expect(selectNextReadyGoalAction(active, {
      completedSubtaskIds: ["research"],
      missingAuthoritySubtaskIds: ["draft"],
      ownerDecisionSubtaskIds: []
    })?.id).toBe("review");
    expect(selectNextReadyGoalAction(active, {
      completedSubtaskIds: ["research", "draft", "review"],
      missingAuthoritySubtaskIds: [],
      ownerDecisionSubtaskIds: []
    })).toBeUndefined();
  });

  it("is pure and does not change the active plan or readiness input", () => {
    const active = plan();
    const readiness = Object.freeze({
      completedSubtaskIds: Object.freeze(["research"]),
      missingAuthoritySubtaskIds: Object.freeze([]),
      ownerDecisionSubtaskIds: Object.freeze([])
    });
    const beforePlan = JSON.stringify(active);
    const beforeReadiness = JSON.stringify(readiness);

    selectNextReadyGoalAction(active, readiness);

    expect(JSON.stringify(active)).toBe(beforePlan);
    expect(JSON.stringify(readiness)).toBe(beforeReadiness);
  });

  it.each([
    {
      completedSubtaskIds: ["missing"],
      missingAuthoritySubtaskIds: [],
      ownerDecisionSubtaskIds: []
    },
    {
      completedSubtaskIds: ["research", "research"],
      missingAuthoritySubtaskIds: [],
      ownerDecisionSubtaskIds: []
    },
    {
      completedSubtaskIds: ["research"],
      missingAuthoritySubtaskIds: ["research"],
      ownerDecisionSubtaskIds: []
    }
  ])("fails closed on unknown, duplicate, or contradictory readiness IDs", (invalid) => {
    expect(() => selectNextReadyGoalAction(plan(), invalid)).toThrow();
  });
});
