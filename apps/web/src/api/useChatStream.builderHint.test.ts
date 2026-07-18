import { describe, expect, it } from "vitest";

import { handleEvent } from "./useChatStream.js";

import type { ChatTurn } from "./useChatStream.js";

const noop = () => {};

function assistantTurn(): ChatTurn {
  return { role: "assistant", text: "" };
}

// The chat-automation-honesty post-pass (apps/api/src/chat-automation-honesty.ts)
// rides the `grounding` SSE frame's `builderHint` field — set to the user's
// original ask when this reply is about a recurring automation chat cannot
// register itself, `null` otherwise. `handleEvent` must copy it onto the turn
// unchanged so the Chat view can render the "Create in Builder" action.

describe("handleEvent — builderHint extraction from the grounding frame", () => {
  it("copies a string builderHint onto the turn", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);

    handleEvent(
      "grounding",
      JSON.stringify({ answer: "정정: ...", builderHint: "매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘" }),
      commit,
      noop,
      noop
    );

    expect(turn.builderHint).toBe("매일 아침 9시에 오늘 일정 요약해주는 자동화 만들어줘");
  });

  it("copies an explicit null builderHint onto the turn", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);

    handleEvent("grounding", JSON.stringify({ answer: "hi", builderHint: null }), commit, noop, noop);

    expect(turn.builderHint).toBeNull();
  });

  it("leaves builderHint untouched when the frame omits it entirely", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);

    handleEvent("grounding", JSON.stringify({ answer: "hi" }), commit, noop, noop);

    expect(turn.builderHint).toBeUndefined();
  });

  it("a malformed grounding frame does not throw", () => {
    expect(() => handleEvent("grounding", "{not json", noop, noop, noop)).not.toThrow();
  });
});
