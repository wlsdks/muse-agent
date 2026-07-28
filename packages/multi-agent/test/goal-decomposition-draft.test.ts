import { describe, expect, it } from "vitest";

import {
  createGoalDecompositionDraft,
  reviseGoalDecompositionDraft
} from "../src/goal-decomposition-draft.js";

describe("goal decomposition draft", () => {
  it("turns an ordered goal into an effect-free editable draft with exact dependencies", () => {
    const draft = createGoalDecompositionDraft(
      "먼저 요구사항을 정리한 뒤 그 결과로 구현 계획을 작성해"
    );

    expect(draft).toEqual({
      assumptions: [],
      goal: "먼저 요구사항을 정리한 뒤 그 결과로 구현 계획을 작성해",
      schemaVersion: 1,
      status: "draft",
      subtasks: [
        { dependsOn: [], id: "subtask_1", title: "요구사항을 정리" },
        {
          dependsOn: ["subtask_1"],
          id: "subtask_2",
          title: "그 결과로 구현 계획을 작성해"
        }
      ],
      unknowns: []
    });
    expect("confirmed" in draft).toBe(false);
    expect("executionAuthorized" in draft).toBe(false);
    expect("taskIds" in draft).toBe(false);
  });

  it("keeps independent list items independent", () => {
    const draft = createGoalDecompositionDraft("- 조사 A\n- 조사 B\n- 조사 C");

    expect(draft.subtasks.map((subtask) => subtask.dependsOn)).toEqual([[], [], []]);
  });

  it("revises plain draft fields without mutating or authorizing the original", () => {
    const original = createGoalDecompositionDraft("1. 조사\n2. 정리", {
      assumptions: ["자료 접근 가능"],
      unknowns: ["마감일"]
    });
    const revised = reviseGoalDecompositionDraft(original, {
      assumptions: ["공개 자료만 사용"],
      subtasks: [
        { dependsOn: [], id: "research", title: "자료 조사" },
        { dependsOn: ["research"], id: "summary", title: "근거 정리" }
      ],
      unknowns: []
    });

    expect(revised).toMatchObject({
      assumptions: ["공개 자료만 사용"],
      status: "draft",
      subtasks: [
        { dependsOn: [], id: "research", title: "자료 조사" },
        { dependsOn: ["research"], id: "summary", title: "근거 정리" }
      ],
      unknowns: []
    });
    expect(original.assumptions).toEqual(["자료 접근 가능"]);
    expect(original.subtasks[0]?.id).toBe("subtask_1");
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.subtasks)).toBe(true);
  });

  it("fails closed on empty goals and invalid dependency graphs", () => {
    expect(() => createGoalDecompositionDraft("   ")).toThrow(/goal/u);

    const draft = createGoalDecompositionDraft("하나의 목표");
    expect(() => reviseGoalDecompositionDraft(draft, {
      subtasks: [
        { dependsOn: [], id: "same", title: "첫째" },
        { dependsOn: [], id: "same", title: "둘째" }
      ]
    })).toThrow(/duplicate/u);
    expect(() => reviseGoalDecompositionDraft(draft, {
      subtasks: [{ dependsOn: ["missing"], id: "only", title: "실행" }]
    })).toThrow(/unknown dependency/u);
    expect(() => reviseGoalDecompositionDraft(draft, {
      subtasks: [{ dependsOn: ["only"], id: "only", title: "실행" }]
    })).toThrow(/depend on itself/u);
    expect(() => reviseGoalDecompositionDraft(draft, {
      subtasks: [
        { dependsOn: ["second"], id: "first", title: "첫째" },
        { dependsOn: ["first"], id: "second", title: "둘째" }
      ]
    })).toThrow(/acyclic/u);
  });
});
