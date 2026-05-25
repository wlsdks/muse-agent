import { describe, expect, it } from "vitest";

import { trimConversationMessages, type ConversationMessage, type TokenEstimator } from "../src/index.js";

const lengthEstimator: TokenEstimator = { estimate: (text) => text.length };

function user(content: string): ConversationMessage {
  return { content, role: "user" };
}
function assistantToolCalls(content: string, ids: readonly string[]): ConversationMessage {
  return { content, role: "assistant", toolCalls: ids.map((id) => ({ arguments: {}, id: `call-${id}`, name: id })) };
}
function toolFor(id: string, content = "result"): ConversationMessage {
  return { content, role: "tool", toolCallId: `call-${id}` };
}

function unansweredToolCalls(messages: readonly ConversationMessage[]): string[] {
  const dangling: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m?.role !== "assistant" || !(m.toolCalls?.length)) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j]?.role === "tool"; j += 1) {
      const id = messages[j]?.toolCallId;
      if (id) answered.add(id);
    }
    for (const tc of m.toolCalls) if (!answered.has(tc.id)) dangling.push(tc.id);
  }
  return dangling;
}

// trimConversationMessages is the last sanitiser before the provider, and a
// tool_use with no matching tool_result is a hard provider 400. It already
// dropped orphan tool RESULTS; these pin the symmetric guarantee for orphan
// tool USES (a partial/interrupted tool turn in history).
describe("trimConversationMessages — never forwards an orphan tool_use", () => {
  it("strips an unanswered tool-call id but keeps the answered one", () => {
    const out = trimConversationMessages(
      [user("keep"), assistantToolCalls("", ["a", "b"]), toolFor("a"), user("latest")],
      { estimator: lengthEstimator, maxContextWindowTokens: 1000, outputReserveTokens: 0 }
    );
    expect(unansweredToolCalls(out.messages)).toEqual([]);
    const asst = out.messages.find((m) => m.role === "assistant");
    expect(asst?.toolCalls?.map((t) => t.id)).toEqual(["call-a"]);
  });

  it("keeps the assistant text when all its tool-calls are unanswered but it has content", () => {
    const out = trimConversationMessages(
      [user("keep"), assistantToolCalls("here is my partial answer", ["a"]), user("latest")],
      { estimator: lengthEstimator, maxContextWindowTokens: 1000, outputReserveTokens: 0 }
    );
    expect(unansweredToolCalls(out.messages)).toEqual([]);
    const asst = out.messages.find((m) => m.content === "here is my partial answer");
    expect(asst).toBeDefined();
    expect(asst?.toolCalls?.length ?? 0).toBe(0);
  });

  it("drops a content-less assistant whose only tool-call is unanswered", () => {
    const out = trimConversationMessages(
      [user("old"), assistantToolCalls("", ["a"]), user("latest")],
      { estimator: lengthEstimator, maxContextWindowTokens: 1000, outputReserveTokens: 0 }
    );
    expect(unansweredToolCalls(out.messages)).toEqual([]);
    expect(out.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("leaves a well-formed multi-tool exchange completely intact", () => {
    const input = [user("old"), assistantToolCalls("", ["a", "b"]), toolFor("a"), toolFor("b"), user("latest")];
    const out = trimConversationMessages(input, {
      estimator: lengthEstimator,
      maxContextWindowTokens: 1000,
      outputReserveTokens: 0
    });
    expect(unansweredToolCalls(out.messages)).toEqual([]);
    const asst = out.messages.find((m) => m.role === "assistant");
    expect(asst?.toolCalls?.map((t) => t.id)).toEqual(["call-a", "call-b"]);
  });
});
