import { describe, expect, it } from "vitest";

import { recencyBonus, scoreMessageContent, scoreMessageImportance } from "../src/message-importance.js";
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

  it("gives plain assistant turns a role bonus", () => {
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

  it("recognises Korean decision vocabulary", () => {
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

  it("recognises expanded English decision vocabulary", () => {
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

  it("ignores too-short activeTaskTitle so a 1-char hint can't saturate every message", () => {
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

  it("ignores too-short activeTaskId and currentFocus the same way", () => {
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

describe("scoreMessageContent + recencyBonus split", () => {
  // split the public `scoreMessageImportance` into the
  // content-only `scoreMessageContent` + the iteration-dependent
  // `recencyBonus`, so the trim's outer while-loop can WeakMap-cache
  // the expensive substring-search work. These tests pin that the
  // combined output still matches the single-call public API across
  // a range of inputs.
  function combine(message: ConversationMessage, context: Parameters<typeof scoreMessageImportance>[1]): number {
    const raw = scoreMessageContent(message, context) + recencyBonus(context.messageIndex, context.totalMessages);
    if (!Number.isFinite(raw)) return 0;
    if (raw < 0) return 0;
    if (raw > 1) return 1;
    return raw;
  }

  it("split-combine equals the single-call public API for plain chat", () => {
    const msg = userMessage("totally generic message");
    const ctx = { messageIndex: 3, totalMessages: 10 };
    expect(combine(msg, ctx)).toBeCloseTo(scoreMessageImportance(msg, ctx), 10);
  });

  it("split-combine equals public API when activeTaskTitle matches", () => {
    const msg = userMessage("update on Ship feature progress");
    const ctx = { activeTaskTitle: "Ship feature", messageIndex: 7, totalMessages: 10 };
    expect(combine(msg, ctx)).toBeCloseTo(scoreMessageImportance(msg, ctx), 10);
  });

  it("split-combine equals public API for tool-call assistant + decision hint", () => {
    const msg = assistantMessage(
      "decided to ship it next sprint",
      [{ arguments: {}, id: "tc-1", name: "calendar.create" }]
    );
    const ctx = { messageIndex: 5, totalMessages: 10 };
    expect(combine(msg, ctx)).toBeCloseTo(scoreMessageImportance(msg, ctx), 10);
  });

  it("recencyBonus returns 1.0 * 0.1 = 0.1 for the newest message in a multi-msg conversation", () => {
    expect(recencyBonus(9, 10)).toBeCloseTo(0.1);
    expect(recencyBonus(0, 10)).toBeCloseTo(0);
  });

  it("recencyBonus returns 0.1 for a one-message conversation (edge case)", () => {
    expect(recencyBonus(0, 1)).toBeCloseTo(0.1);
  });
});

describe("scoreMessageContent — exact per-role + hint increments (mutation-pinned)", () => {
  const m = (role: ConversationMessage["role"], content = "neutral chatter", extra: Partial<ConversationMessage> = {}): ConversationMessage =>
    ({ content, role, ...extra });

  it("pins each role's exact bonus over the 0.1 base (no relative-only coverage)", () => {
    // base 0.1 + role bonus; neutral content so no hint/decision bonus applies.
    expect(scoreMessageContent(m("user"), {})).toBeCloseTo(0.3); // +0.2
    expect(scoreMessageContent(m("system"), {})).toBeCloseTo(0.3); // +0.2
    expect(scoreMessageContent(m("assistant"), {})).toBeCloseTo(0.3); // plain assistant +0.2
    expect(scoreMessageContent(m("tool"), {})).toBeCloseTo(0.5); // +0.4
    expect(scoreMessageContent(m("assistant", "x", { toolCalls: [{ arguments: {}, id: "1", name: "t" }] }), {})).toBeCloseTo(0.5); // +0.4
  });

  it("gives an UNKNOWN role only the base score (no role bonus branch matches)", () => {
    expect(scoreMessageContent({ content: "x", role: "function" as ConversationMessage["role"] }, {})).toBeCloseTo(0.1);
  });

  it("adds the activeTaskTitle bonus only for a matchable (>=3-char) hint — a 2-char hint is ignored", () => {
    expect(scoreMessageContent(m("user", "work on rag today"), { activeTaskTitle: "rag" })).toBeCloseTo(0.8); // 0.1 + 0.2 + 0.5
    expect(scoreMessageContent(m("user", "say hi now"), { activeTaskTitle: "hi" })).toBeCloseTo(0.3); // 2-char hint ignored
  });

  it("caps the decision-hint bonus at ONE +0.2 even when the message holds multiple decision words (the loop breaks)", () => {
    // "decided" AND "agreed" are both DECISION_HINTS; the for-loop breaks after
    // the first match, so the bonus is +0.2 once, not +0.4.
    // base 0.1 + user role 0.2 + decision 0.2 (once) = 0.5
    expect(scoreMessageContent(m("user", "we decided and agreed on the plan"), {})).toBeCloseTo(0.5);
  });
});
