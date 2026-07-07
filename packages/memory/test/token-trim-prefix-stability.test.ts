/**
 * Prefix-cache-friendliness regression lock: a compaction summary must be
 * inserted AFTER any real leading system message (the caller's actual
 * system prompt), never before it. A provider that caches on a stable
 * prefix sees the prefix change on every compaction round if the summary
 * (which changes every round) is pushed in FRONT of the unchanging system
 * prompt instead of after it.
 */
import { describe, expect, it } from "vitest";

import {
  COMPACTION_SUMMARY_PREFIX,
  trimConversationMessages,
  type ConversationMessage,
  type TokenEstimator
} from "../src/index.js";

const est: TokenEstimator = { estimate: (t) => (t ?? "").length };
const m = (role: ConversationMessage["role"], content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ content, role, ...extra });

function longConversation(realSystemPrompt: string): ConversationMessage[] {
  const msgs: ConversationMessage[] = [m("system", realSystemPrompt)];
  for (let i = 0; i < 10; i++) {
    msgs.push(m("user", `old turn ${i.toString()} `.repeat(10)));
    msgs.push(m("assistant", `old reply ${i.toString()} `.repeat(10)));
  }
  msgs.push(m("user", "the latest question"));
  return msgs;
}

describe("trimConversationMessages — compaction summary placement (stable prefix)", () => {
  it("keeps a real leading system prompt at index 0 and inserts the summary AFTER it", () => {
    const realSystemPrompt = "REAL-SYSTEM-PROMPT-MARKER";
    const result = trimConversationMessages(longConversation(realSystemPrompt), {
      compactionThreshold: 1,
      estimator: est,
      maxContextWindowTokens: 500,
      outputReserveTokens: 10
    });

    expect(result.summaryInserted).toBe(true);
    // the real system prompt is UNCHANGED and stays the stable prefix
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe(realSystemPrompt);
    // the summary is inserted right after it, not before
    expect(result.messages[1]?.role).toBe("system");
    expect(result.messages[1]?.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
  });

  it("merges into the existing summary slot (after the real system prompt) on a second compaction round, without duplicating or displacing the prompt", () => {
    const realSystemPrompt = "REAL-SYSTEM-PROMPT-MARKER";
    const first = trimConversationMessages(longConversation(realSystemPrompt), {
      compactionThreshold: 1,
      estimator: est,
      maxContextWindowTokens: 500,
      outputReserveTokens: 10
    });
    expect(first.messages[0]?.content).toBe(realSystemPrompt);

    const second = trimConversationMessages(
      [
        ...first.messages,
        m("user", "another old turn ".repeat(10)),
        m("assistant", "another old reply ".repeat(10)),
        m("user", "yet another old turn ".repeat(10)),
        m("assistant", "yet another old reply ".repeat(10)),
        m("user", "the newest question")
      ],
      {
        compactionThreshold: 1,
        estimator: est,
        maxContextWindowTokens: 500,
        outputReserveTokens: 10
      }
    );

    expect(second.messages[0]?.content).toBe(realSystemPrompt);
    expect(second.messages[1]?.role).toBe("system");
    expect(second.messages[1]?.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    // exactly one summary message survives — no duplicate slot pushed further down
    const summaryCount = second.messages.filter(
      (message) => message.role === "system" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX)
    ).length;
    expect(summaryCount).toBe(1);
  });

  it("byte-identical behavior when there is no real leading system message (summary at index 0, as before)", () => {
    const msgs: ConversationMessage[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(m("user", `old turn ${i.toString()} `.repeat(10)));
      msgs.push(m("assistant", `old reply ${i.toString()} `.repeat(10)));
    }
    msgs.push(m("user", "the latest question"));

    const result = trimConversationMessages(msgs, {
      compactionThreshold: 1,
      estimator: est,
      maxContextWindowTokens: 500,
      outputReserveTokens: 10
    });

    expect(result.summaryInserted).toBe(true);
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
  });
});
