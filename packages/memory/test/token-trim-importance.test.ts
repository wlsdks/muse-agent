import { describe, expect, it } from "vitest";

import { trimConversationMessages, type ConversationMessage } from "../src/index.js";

function user(content: string): ConversationMessage {
  return { content, role: "user" };
}

function assistant(content: string): ConversationMessage {
  return { content, role: "assistant" };
}

describe("trimConversationMessages with compactionStrategy=\"importance\"", () => {
  it("preserves messages that mention the active task even when older", () => {
    // 8 chat turns + a final pivotal user message. The first message
    // explicitly references the active task and should survive the
    // importance trim even though it's the oldest user message.
    const messages: readonly ConversationMessage[] = [
      { content: "[system]", role: "system" },
      user("decision: we'll ship Ship feature next sprint"),
      assistant("noted"),
      user("ate lunch"),
      assistant("ok"),
      user("watched a movie"),
      assistant("ok"),
      user("weather is nice"),
      assistant("indeed"),
      user("update?")
    ];

    const result = trimConversationMessages(messages, {
      compactionStrategy: "importance",
      importanceContext: { activeTaskTitle: "Ship feature" },
      importanceThreshold: 0.6,
      // very low budget — forces aggressive trim
      maxContextWindowTokens: 200,
      outputReserveTokens: 50
    });

    const surviving = result.messages.map((message) => message.content).join("\n");
    expect(surviving).toContain("Ship feature");
    expect(result.removedCount).toBeGreaterThan(0);
  });

  it("falls back to temporal trim when strategy is default", () => {
    const messages: readonly ConversationMessage[] = [
      user("oldest message about Ship feature"),
      ...Array.from({ length: 8 }, (_, index) => user(`filler ${(index + 1).toString()}`)),
      user("latest")
    ];

    const result = trimConversationMessages(messages, {
      // No compactionStrategy field — default temporal
      maxContextWindowTokens: 200,
      outputReserveTokens: 50
    });

    // Latest user message must always survive.
    expect(result.messages[result.messages.length - 1]?.content).toBe("latest");
  });
});
