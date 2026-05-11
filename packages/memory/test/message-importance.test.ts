import { describe, expect, it } from "vitest";

import { scoreMessageImportance } from "../src/message-importance.js";
import type { ConversationMessage } from "../src/index.js";

function userMessage(content: string): ConversationMessage {
  return { content, role: "user" };
}

function assistantMessage(content: string, toolCalls?: ConversationMessage["toolCalls"]): ConversationMessage {
  return { content, role: "assistant", toolCalls };
}

describe("scoreMessageImportance", () => {
  it("scores tool-call assistant messages higher than plain assistant chat", () => {
    const plain = scoreMessageImportance(assistantMessage("ok"), { messageIndex: 0, totalMessages: 10 });
    const withTool = scoreMessageImportance(
      assistantMessage("running", [{ arguments: {}, id: "tc-1", name: "x" }]),
      { messageIndex: 0, totalMessages: 10 }
    );
    expect(withTool).toBeGreaterThan(plain);
  });

  it("boosts messages that name the active task", () => {
    const base = scoreMessageImportance(userMessage("hi"), { messageIndex: 0, totalMessages: 10 });
    const targeted = scoreMessageImportance(userMessage("update on Ship feature"), {
      activeTaskTitle: "Ship feature",
      messageIndex: 0,
      totalMessages: 10
    });
    expect(targeted).toBeGreaterThan(base);
  });

  it("recency bumps later messages above earlier ones (same content)", () => {
    const earlier = scoreMessageImportance(userMessage("update"), { messageIndex: 0, totalMessages: 10 });
    const later = scoreMessageImportance(userMessage("update"), { messageIndex: 9, totalMessages: 10 });
    expect(later).toBeGreaterThan(earlier);
  });

  it("stays within [0, 1]", () => {
    const score = scoreMessageImportance(
      assistantMessage("step 1 step 2 decided ship feature", [{ arguments: {}, id: "x", name: "y" }]),
      {
        activeTaskId: "T-1",
        activeTaskTitle: "ship feature",
        currentFocus: "ship feature",
        messageIndex: 9,
        totalMessages: 10
      }
    );
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0);
  });
});
