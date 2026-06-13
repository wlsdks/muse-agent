import { describe, expect, it } from "vitest";

import {
  estimateConversationTokens,
  trimConversationMessages,
  type ConversationMessage,
  type TokenEstimator
} from "../src/index.js";

// A deterministic 1-char = 1-token estimator so budgets are exact and readable
// (the default approximate estimator's code-point bucketing is not the unit
// under test here — the trim STRATEGY is).
const est: TokenEstimator = { estimate: (t) => (t ?? "").length };
const m = (role: ConversationMessage["role"], content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ content, role, ...extra });
const base = (extra: Record<string, unknown> = {}) => ({
  estimator: est,
  insertSummary: false,
  maxContextWindowTokens: 1000,
  messageStructureOverhead: 0,
  outputReserveTokens: 0,
  ...extra
});

describe("estimateConversationTokens", () => {
  it("sums each message's estimated tokens", () => {
    expect(estimateConversationTokens([m("user", "12345"), m("assistant", "123")], { estimator: est, messageStructureOverhead: 0 })).toBe(8);
  });

  it("adds the per-message structure overhead and is 0 for an empty conversation", () => {
    expect(estimateConversationTokens([], { estimator: est, messageStructureOverhead: 20 })).toBe(0);
    // two messages × 5 chars + 2 × 10 overhead = 30
    expect(estimateConversationTokens([m("user", "abcde"), m("assistant", "fghij")], { estimator: est, messageStructureOverhead: 10 })).toBe(30);
  });
});

describe("trimConversationMessages — budget arithmetic + no-op", () => {
  it("leaves a conversation under budget untouched (triggeredBy none, nothing removed)", () => {
    const conv = [m("system", "sys"), m("user", "aaaa"), m("assistant", "bbbb"), m("user", "cccc")];
    const r = trimConversationMessages(conv, base());
    expect(r.triggeredBy).toBe("none");
    expect(r.removedCount).toBe(0);
    expect(r.messages).toEqual(conv);
    expect(r.summaryInserted).toBe(false);
  });

  it("subtracts systemPrompt + outputReserve + toolTokenReserve from the hard budget", () => {
    const r = trimConversationMessages([m("user", "hi")], base({
      maxContextWindowTokens: 100,
      outputReserveTokens: 20,
      systemPrompt: "1234567890", // 10 tokens
      toolTokenReserve: 15
    }));
    expect(r.budgetTokens).toBe(100 - 10 - 20 - 15);
  });
});

describe("trimConversationMessages — hard limit", () => {
  it("when the budget is non-positive, keeps only the last user message", () => {
    const conv = [m("system", "s"), m("user", "aaaa"), m("assistant", "bbbb"), m("user", "cccc")];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 0 }));
    expect(r.triggeredBy).toBe("hard_limit");
    expect(r.messages.map((x) => x.content)).toEqual(["cccc"]);
  });

  it("with a non-positive budget but a single message, returns it unchanged (no empty conversation)", () => {
    const conv = [m("user", "only")];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 0 }));
    expect(r.messages.map((x) => x.content)).toEqual(["only"]);
  });

  it("with a non-positive budget and NO user message, keeps all messages (never anchors on a non-existent user turn)", () => {
    const conv = [m("system", "s"), m("assistant", "aaaa"), m("assistant", "bbbb")];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 0 }));
    expect(r.triggeredBy).toBe("hard_limit");
    expect(r.messages.map((x) => x.content)).toEqual(["s", "aaaa", "bbbb"]);
  });

  it("trims oldest history to fit the hard budget, preserving system + the latest user turn", () => {
    const conv = [
      m("system", "s"),
      m("user", "x".repeat(10)),
      m("assistant", "y".repeat(10)),
      m("user", "z".repeat(10)),
      m("user", "q")
    ];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 15 }));
    expect(r.triggeredBy).toBe("hard_limit");
    expect(r.estimatedTokens).toBeLessThanOrEqual(r.budgetTokens);
    expect(r.messages[0]!.content).toBe("s"); // system preserved
    expect(r.messages.at(-1)!.content).toBe("q"); // latest user turn preserved
    expect(r.removedCount).toBeGreaterThan(0);
  });
});

describe("trimConversationMessages — working budget (proactive compaction)", () => {
  const big = [
    m("system", "s"),
    m("user", "x".repeat(10)),
    m("assistant", "y".repeat(10)),
    m("user", "z".repeat(10)),
    m("user", "q")
  ];

  it("fires at the working budget while still under the hard cap (triggeredBy working_budget)", () => {
    const r = trimConversationMessages(big, base({ maxContextWindowTokens: 100, workingBudgetTokens: 20 }));
    expect(r.triggeredBy).toBe("working_budget");
    expect(r.removedCount).toBeGreaterThan(0);
  });

  it("a working budget above the hard cap is clamped down (never raises the effective target)", () => {
    // workingBudget 999 > hard 15 → silently falls back to the hard cap; the
    // trim still fires by hard_limit, not a meaningless working trigger.
    const r = trimConversationMessages(big, base({ maxContextWindowTokens: 15, workingBudgetTokens: 999 }));
    expect(r.triggeredBy).toBe("hard_limit");
  });

  it("does not fire when the conversation is under the working budget", () => {
    const small = [m("system", "s"), m("user", "hi")];
    const r = trimConversationMessages(small, base({ maxContextWindowTokens: 100, workingBudgetTokens: 50 }));
    expect(r.triggeredBy).toBe("none");
    expect(r.removedCount).toBe(0);
  });
});

describe("trimConversationMessages — structural integrity + summary", () => {
  it("removes an orphaned tool response whose tool call was trimmed away", () => {
    const conv = [
      m("system", "s"),
      m("user", "x".repeat(20)),
      m("assistant", "y".repeat(20)),
      m("tool", "orphan-tool-result", { toolCallId: "tc1" } as Partial<ConversationMessage>),
      m("user", "q")
    ];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 25 }));
    // the tool-role message must not survive without its originating tool call.
    expect(r.messages.some((x) => x.role === "tool")).toBe(false);
  });

  it("inserts a [Conversation summary …] system message once enough messages are dropped", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    const r = trimConversationMessages(many, base({ insertSummary: true, maxContextWindowTokens: 40 }));
    expect(r.summaryInserted).toBe(true);
    expect(r.messages.some((x) => typeof x.content === "string" && x.content.includes("[Conversation summary"))).toBe(true);
  });

  it("suppresses the summary when insertSummary is false even though many messages were dropped", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    const r = trimConversationMessages(many, base({ insertSummary: false, maxContextWindowTokens: 40 }));
    expect(r.summaryInserted).toBe(false);
    expect(r.messages.some((x) => typeof x.content === "string" && x.content.includes("[Conversation summary"))).toBe(false);
  });

  it("respects a custom compactionThreshold (no summary until that many are dropped)", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    // A threshold larger than any plausible drop count → no summary even though the trim fires.
    const r = trimConversationMessages(many, base({ compactionThreshold: 9999, insertSummary: true, maxContextWindowTokens: 40 }));
    expect(r.summaryInserted).toBe(false);
  });
});
