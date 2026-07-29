import { describe, expect, it } from "vitest";

import {
  projectTaskIntentDraft,
  type TaskIntentObservation
} from "../src/index.js";

function observation(
  over: Partial<TaskIntentObservation> = {}
): TaskIntentObservation {
  return {
    intentClass: "owner-commitment",
    source: {
      conversationId: "conversation_01",
      text: "여행 준비해야겠다",
      turnId: "turn_07"
    },
    ...over
  };
}

describe("projectTaskIntentDraft", () => {
  it("keeps a vague owner intent inert and asks for the missing next action and due", () => {
    const input = observation({ proposedTitle: "여행 준비" });
    const before = JSON.stringify(input);
    const first = projectTaskIntentDraft(input);
    const second = projectTaskIntentDraft(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      authority: {
        deadlineInference: "none",
        decomposition: "none",
        taskWrite: "none"
      },
      createAction: {
        action: "create-task",
        draftId: expect.stringMatching(/^taskdraft_v1_[a-f0-9]{32}$/u),
        requiredAuthority: "explicit-owner-confirmation",
        status: "blocked"
      },
      due: { state: "missing" },
      missing: [
        { field: "nextAction", question: "What is the next concrete action?" },
        { field: "due", question: "When, if at all, should this be due?" }
      ],
      nextAction: { state: "missing" },
      proposedList: "personal-tasks",
      source: {
        conversationId: "conversation_01",
        textDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        turnId: "turn_07"
      },
      status: "needs-clarification",
      title: "여행 준비"
    });
    expect(first).not.toHaveProperty("task");
    expect(first).not.toHaveProperty("providerId");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.authority)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);

    const whitespaceChangedSource = projectTaskIntentDraft(observation({
      proposedTitle: "여행 준비",
      source: {
        ...observation().source,
        text: " 여행 준비해야겠다 "
      }
    }));
    expect(first.status).not.toBe("rejected");
    expect(whitespaceChangedSource.status).not.toBe("rejected");
    if (first.status !== "rejected" && whitespaceChangedSource.status !== "rejected") {
      expect(whitespaceChangedSource.source.textDigest).not.toBe(first.source.textDigest);
      expect(whitespaceChangedSource.draftId).not.toBe(first.draftId);
    }
  });

  it("uses only user-stated next action and due text and still requires confirmation", () => {
    const result = projectTaskIntentDraft(observation({
      dueText: "금요일까지",
      nextAction: "항공권 가격 확인",
      proposedTitle: "여행 준비",
      source: {
        conversationId: "conversation_01",
        text: "여행 준비: 항공권 가격 확인, 금요일까지",
        turnId: "turn_08"
      }
    }));

    expect(result).toMatchObject({
      createAction: {
        requiredAuthority: "explicit-owner-confirmation",
        status: "blocked"
      },
      due: { state: "user-stated", text: "금요일까지" },
      missing: [],
      nextAction: { state: "user-stated", text: "항공권 가격 확인" },
      status: "ready-for-confirmation"
    });
  });

  it("rejects questions, assumptions, third-party intents, invented fields, and authority-shaped extras", () => {
    for (const intentClass of ["question", "assumption", "third-party"] as const) {
      expect(projectTaskIntentDraft(observation({ intentClass }))).toEqual({
        authority: { deadlineInference: "none", taskWrite: "none" },
        createAction: "none",
        reason: intentClass,
        status: "rejected"
      });
    }
    expect(projectTaskIntentDraft(observation({
      dueText: "내일",
      proposedTitle: "여행 준비"
    }))).toMatchObject({
      createAction: "none",
      reason: "invalid-input",
      status: "rejected"
    });
    expect(projectTaskIntentDraft(observation({
      nextAction: "호텔 예약",
      proposedTitle: "여행 준비"
    }))).toMatchObject({
      createAction: "none",
      reason: "invalid-input",
      status: "rejected"
    });
    expect(projectTaskIntentDraft({
      ...observation(),
      taskWrite: true
    } as TaskIntentObservation)).toMatchObject({
      createAction: "none",
      reason: "invalid-input",
      status: "rejected"
    });
    expect(projectTaskIntentDraft(observation({
      source: {
        ...observation().source,
        approval: true
      } as TaskIntentObservation["source"]
    }))).toMatchObject({
      createAction: "none",
      reason: "invalid-input",
      status: "rejected"
    });
    expect(projectTaskIntentDraft(observation({
      proposedTitle: "   "
    }))).toMatchObject({
      createAction: "none",
      reason: "invalid-input",
      status: "rejected"
    });

    const hiddenAuthority = observation();
    Object.defineProperty(hiddenAuthority, "taskWrite", {
      enumerable: false,
      value: true
    });
    expect(projectTaskIntentDraft(hiddenAuthority)).toMatchObject({
      createAction: "none",
      reason: "invalid-input",
      status: "rejected"
    });

    const symbolAuthority = observation() as TaskIntentObservation & {
      [key: symbol]: unknown;
    };
    symbolAuthority[Symbol("approval")] = true;
    expect(projectTaskIntentDraft(symbolAuthority)).toMatchObject({
      createAction: "none",
      reason: "invalid-input",
      status: "rejected"
    });
  });
});
