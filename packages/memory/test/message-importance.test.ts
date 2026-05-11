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

  it("gives plain assistant turns a role bonus (iter 6 regression — previously 0)", () => {
    // Previously plain assistant text fell through every role
    // branch in the if/else-if chain and got 0 role bonus, which
    // kept every assistant reply under the default threshold (0.5)
    // and made them ALL trim candidates. Now equal to user/system.
    const plain = scoreMessageImportance(assistantMessage("here's what I found"), {
      messageIndex: 5,
      totalMessages: 10
    });
    const user = scoreMessageImportance(userMessage("here's what I found"), {
      messageIndex: 5,
      totalMessages: 10
    });
    // Plain assistant should now be at least as high as a plain
    // user message of the same content — not stuck at the base.
    expect(plain).toBeGreaterThanOrEqual(user);
    expect(plain).toBeGreaterThan(0.2);
  });

  it("recognises Korean decision vocabulary (iter 6)", () => {
    const plain = scoreMessageImportance(userMessage("뭐 먹을지 고민"), {
      messageIndex: 0,
      totalMessages: 10
    });
    const decisive = scoreMessageImportance(userMessage("우리 Kysely로 결정"), {
      messageIndex: 0,
      totalMessages: 10
    });
    const agreement = scoreMessageImportance(userMessage("그 방향으로 합의 봤어"), {
      messageIndex: 0,
      totalMessages: 10
    });
    expect(decisive).toBeGreaterThan(plain);
    expect(agreement).toBeGreaterThan(plain);
  });

  it("recognises expanded English decision vocabulary (iter 6)", () => {
    const plain = scoreMessageImportance(userMessage("idle chitchat"), {
      messageIndex: 0,
      totalMessages: 10
    });
    const decisive = scoreMessageImportance(userMessage("signed off on the rollout"), {
      messageIndex: 0,
      totalMessages: 10
    });
    const shipIt = scoreMessageImportance(userMessage("ship it"), {
      messageIndex: 0,
      totalMessages: 10
    });
    expect(decisive).toBeGreaterThan(plain);
    expect(shipIt).toBeGreaterThan(plain);
  });

  it("ignores too-short activeTaskTitle so a 1-char hint can't saturate every message (iter 18)", () => {
    // Pathological: a one-character activeTaskTitle like "X" would
    // substring-match every English message ("X" appears in "fix",
    // "exit", "tax" …). The guard rejects hints shorter than 3
    // chars so unrelated chatter doesn't get the +0.5 bonus.
    const unrelatedWithShortHint = scoreMessageImportance(userMessage("just casual chitchat"), {
      activeTaskTitle: "X",
      messageIndex: 5,
      totalMessages: 10
    });
    const unrelatedWithoutHint = scoreMessageImportance(userMessage("just casual chitchat"), {
      messageIndex: 5,
      totalMessages: 10
    });
    // Both should score the same — the short hint must not boost.
    expect(unrelatedWithShortHint).toBe(unrelatedWithoutHint);

    // A 3+ char hint still boosts when the message references it.
    const matchedWithRealHint = scoreMessageImportance(userMessage("update on Ship feature"), {
      activeTaskTitle: "Ship feature",
      messageIndex: 5,
      totalMessages: 10
    });
    expect(matchedWithRealHint).toBeGreaterThan(unrelatedWithoutHint);
  });

  it("ignores too-short activeTaskId and currentFocus the same way (iter 18)", () => {
    const base = scoreMessageImportance(userMessage("totally unrelated stuff"), {
      messageIndex: 0,
      totalMessages: 10
    });
    const shortId = scoreMessageImportance(userMessage("totally unrelated stuff"), {
      activeTaskId: "T1", // 2 chars — must be rejected
      messageIndex: 0,
      totalMessages: 10
    });
    const shortFocus = scoreMessageImportance(userMessage("totally unrelated stuff"), {
      currentFocus: "hi", // 2 chars — must be rejected
      messageIndex: 0,
      totalMessages: 10
    });
    expect(shortId).toBe(base);
    expect(shortFocus).toBe(base);
  });
});
