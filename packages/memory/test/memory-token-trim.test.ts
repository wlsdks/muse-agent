import { describe, expect, it } from "vitest";

import {
  COMPACTION_RESUME_DIRECTIVE,
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

  it("includes the anti-resume directive in the inserted summary, and not when no summary is inserted", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    const compacted = trimConversationMessages(many, base({ insertSummary: true, maxContextWindowTokens: 40 }));
    expect(compacted.messages.some((x) => x.content.includes(COMPACTION_RESUME_DIRECTIVE))).toBe(true);
    // a conversation that fits → no summary → no directive
    const small = trimConversationMessages([m("system", "s"), m("user", "hi")], base({ insertSummary: true, maxContextWindowTokens: 10_000 }));
    expect(small.messages.some((x) => x.content.includes(COMPACTION_RESUME_DIRECTIVE))).toBe(false);
  });

  it("does not duplicate the anti-resume directive across successive compaction rounds", () => {
    const round1: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      round1.push(m("user", "u".repeat(8)));
      round1.push(m("assistant", "a".repeat(8)));
    }
    round1.push(m("user", "final one"));
    const r1 = trimConversationMessages(round1, base({ insertSummary: true, maxContextWindowTokens: 40 }));
    // feed the (summary-bearing) result back through another compaction round
    const round2 = [...r1.messages];
    for (let i = 0; i < 8; i += 1) {
      round2.push(m("user", "v".repeat(8)));
      round2.push(m("assistant", "b".repeat(8)));
    }
    round2.push(m("user", "final two"));
    const r2 = trimConversationMessages(round2, base({ insertSummary: true, maxContextWindowTokens: 40 }));
    const summary = r2.messages.find((x) => x.content.includes(COMPACTION_RESUME_DIRECTIVE));
    expect(summary).toBeDefined();
    expect(summary!.content.split(COMPACTION_RESUME_DIRECTIVE).length - 1).toBe(1); // exactly once
  });

  it("exposes the compacted-away messages in `dropped` (for CMP-2 aux summary)", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    const r = trimConversationMessages(many, base({ insertSummary: true, maxContextWindowTokens: 40 }));
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.dropped.every((d) => many.includes(d))).toBe(true);
    expect(r.dropped.some((d) => r.messages.includes(d))).toBe(false);
  });

  it("returns an empty `dropped` when the conversation fits (no compaction)", () => {
    const r = trimConversationMessages([m("system", "s"), m("user", "hi")], base({ maxContextWindowTokens: 10_000 }));
    expect(r.dropped).toEqual([]);
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

describe("trimConversationMessages — compactionFailureReason telemetry", () => {
  it("is undefined when nothing needed trimming", () => {
    const conv = [m("system", "sys"), m("user", "aaaa"), m("assistant", "bbbb"), m("user", "cccc")];
    const r = trimConversationMessages(conv, base());
    expect(r.compactionFailureReason).toBeUndefined();
  });

  it("is undefined on a normal successful compaction (summary inserted, comfortably under the hard budget)", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    // A big hard cap with a small working budget: the proactive trim fires,
    // drops well past compactionThreshold, and the inserted summary
    // (including its resume-directive boilerplate) still fits comfortably
    // under the 1000-token hard ceiling — a genuinely clean run.
    const r = trimConversationMessages(
      many,
      base({ insertSummary: true, maxContextWindowTokens: 1000, workingBudgetTokens: 50 })
    );
    expect(r.summaryInserted).toBe(true);
    expect(r.estimatedTokens).toBeLessThanOrEqual(r.budgetTokens);
    expect(r.compactionFailureReason).toBeUndefined();
  });

  it("is guard_blocked when the reserved overhead alone exceeds the window (non-positive hard budget)", () => {
    const conv = [m("system", "s"), m("user", "aaaa"), m("assistant", "bbbb"), m("user", "cccc")];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 0 }));
    expect(r.compactionFailureReason).toBe("guard_blocked");
  });

  it("is no_compactable_entries when trim fires but there is nothing removable (single protected user turn)", () => {
    const conv = [m("system", "s"), m("user", "X".repeat(50))];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 10 }));
    expect(r.removedCount).toBe(0);
    expect(r.compactionFailureReason).toBe("no_compactable_entries");
  });

  it("is guard_blocked when some content is removed but the protected last turn alone still exceeds the hard budget", () => {
    const conv = [m("system", "s"), m("user", "aaaaa"), m("assistant", "bbbbb"), m("user", "Z".repeat(100))];
    const r = trimConversationMessages(conv, base({ maxContextWindowTokens: 20 }));
    expect(r.removedCount).toBeGreaterThan(0);
    expect(r.estimatedTokens).toBeGreaterThan(r.budgetTokens);
    expect(r.compactionFailureReason).toBe("guard_blocked");
  });

  it("is below_threshold when messages were dropped but not enough to cross compactionThreshold", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    const r = trimConversationMessages(many, base({ compactionThreshold: 9999, insertSummary: true, maxContextWindowTokens: 40 }));
    expect(r.summaryInserted).toBe(false);
    expect(r.compactionFailureReason).toBe("below_threshold");
  });

  it("is undefined (not below_threshold) when the caller explicitly opted out of summaries via insertSummary: false", () => {
    const many: ConversationMessage[] = [m("system", "s")];
    for (let i = 0; i < 8; i += 1) {
      many.push(m("user", "u".repeat(8)));
      many.push(m("assistant", "a".repeat(8)));
    }
    many.push(m("user", "final"));
    const r = trimConversationMessages(many, base({ insertSummary: false, maxContextWindowTokens: 40 }));
    expect(r.summaryInserted).toBe(false);
    expect(r.compactionFailureReason).toBeUndefined();
  });
});

describe("trimConversationMessages — current tool exchange protection", () => {
  const conversation = (): ConversationMessage[] => [
    m("user", "old".repeat(100)),
    m("assistant", "answer".repeat(100)),
    m("user", "latest https://example.invalid/item"),
    m("assistant", "", { toolCalls: [{ arguments: {}, id: "t1", name: "lookup" }] }),
    m("tool", "CURRENT_RESULT", { name: "lookup", toolCallId: "t1" })
  ];

  it("drops older history but retains the newest complete assistant/tool pair", () => {
    const result = trimConversationMessages(conversation(), base({
      maxContextWindowTokens: 100,
      preserveLatestToolExchange: true
    }));
    expect(result.messages.some((message) => message.content.includes("old"))).toBe(false);
    expect(result.messages.some((message) => message.toolCalls?.[0]?.id === "t1")).toBe(true);
    expect(result.messages.some((message) => message.toolCallId === "t1" && message.content === "CURRENT_RESULT")).toBe(true);
    expect(result.messages.some((message) => message.content.includes("https://example.invalid/item"))).toBe(true);
  });

  it("reports an irreducible over-budget suffix instead of deleting its execution evidence", () => {
    const result = trimConversationMessages(conversation(), base({
      maxContextWindowTokens: 10,
      preserveLatestToolExchange: true
    }));
    expect(result.estimatedTokens).toBeGreaterThan(result.budgetTokens);
    expect(result.compactionFailureReason).toBe("guard_blocked");
    expect(result.messages.some((message) => message.toolCalls?.[0]?.id === "t1")).toBe(true);
    expect(result.messages.some((message) => message.toolCallId === "t1")).toBe(true);
  });
});
