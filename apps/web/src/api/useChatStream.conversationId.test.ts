import { describe, expect, it, vi } from "vitest";

import { chatStreamRequestBody, handleEvent } from "./useChatStream.js";

import type { ChatTurn } from "./useChatStream.js";

const noop = () => {};

function assistantTurn(): ChatTurn {
  return { role: "assistant", text: "" };
}

// AC2: the round-trip — a server-issued conversationId comes back on a
// `grounding` or `done` SSE frame, `handleEvent` hands it to the stored-id
// setter, and `chatStreamRequestBody` puts it back on the NEXT request. No
// id yet (a fresh chat) ⇒ the field is omitted entirely, matching AC1's
// "absent ⇒ server generates one" contract.

describe("chatStreamRequestBody — conversationId round-trip request shape", () => {
  it("omits conversationId on a fresh chat (no id yet)", () => {
    expect(chatStreamRequestBody("hello")).toEqual({ message: "hello" });
  });

  it("carries a stored conversationId on a subsequent send", () => {
    expect(chatStreamRequestBody("what's next?", "conv_ab12cd34")).toEqual({
      conversationId: "conv_ab12cd34",
      message: "what's next?"
    });
  });
});

describe("handleEvent — conversationId extraction from the grounding frame", () => {
  it("hands the parsed conversationId to onConversationId", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);
    const onConversationId = vi.fn();

    handleEvent(
      "grounding",
      JSON.stringify({ answer: "hi", conversationId: "conv_ab12cd34" }),
      commit,
      noop,
      noop,
      onConversationId
    );

    expect(onConversationId).toHaveBeenCalledWith("conv_ab12cd34");
    expect(turn.text).toBe("hi");
  });

  it("does not call onConversationId when the frame carries none", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);
    const onConversationId = vi.fn();

    handleEvent("grounding", JSON.stringify({ answer: "hi" }), commit, noop, noop, onConversationId);

    expect(onConversationId).not.toHaveBeenCalled();
  });

  it("a malformed grounding frame does not throw and does not call onConversationId", () => {
    const onConversationId = vi.fn();
    expect(() => handleEvent("grounding", "{not json", noop, noop, noop, onConversationId)).not.toThrow();
    expect(onConversationId).not.toHaveBeenCalled();
  });

  it("is safe to call without an onConversationId callback (compat with the pre-S3b call sites)", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);
    expect(() =>
      handleEvent("grounding", JSON.stringify({ answer: "hi", conversationId: "conv_x" }), commit, noop, noop)
    ).not.toThrow();
  });
});

describe("handleEvent — conversationId extraction from the (extended-mode) done frame", () => {
  it("hands the parsed conversationId to onConversationId", () => {
    const turn = assistantTurn();
    const commit = (mut: (t: ChatTurn) => void) => mut(turn);
    const onConversationId = vi.fn();

    handleEvent(
      "done",
      JSON.stringify({ conversationId: "conv_ab12cd34", response: "final answer" }),
      commit,
      noop,
      noop,
      onConversationId
    );

    expect(onConversationId).toHaveBeenCalledWith("conv_ab12cd34");
    expect(turn.text).toBe("final answer");
  });

  it("compat mode's empty done payload does not throw and does not call onConversationId", () => {
    const onConversationId = vi.fn();
    expect(() => handleEvent("done", "", noop, noop, noop, onConversationId)).not.toThrow();
    expect(onConversationId).not.toHaveBeenCalled();
  });
});
