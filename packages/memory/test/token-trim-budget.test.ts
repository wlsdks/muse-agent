import { describe, expect, it } from "vitest";

import {
  COMPACTION_SUMMARY_PREFIX,
  estimateConversationTokens,
  trimConversationMessages,
  type ConversationMessage
} from "../src/index.js";

// Coverage for the DEFAULT (temporal) conversation-trim contract +
// estimateConversationTokens. The existing token-trim test covers only the
// compactionStrategy="importance" path; the budget math, the triggeredBy
// three-state, summary insertion, and tool-pair integrity on the default path
// were untested. This is the context-window manager — a wrong trim either drops
// the message the agent needed or blows the model's token budget.

const msg = (role: ConversationMessage["role"], content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ content, role, ...extra }) as ConversationMessage;

const longConversation = (pairs: number): ConversationMessage[] => {
  const out: ConversationMessage[] = [];
  for (let i = 0; i < pairs; i += 1) {
    out.push(msg("user", `question number ${i.toString()} with several words here`));
    out.push(msg("assistant", `answer number ${i.toString()} with several words here`));
  }
  return out;
};

describe("estimateConversationTokens", () => {
  it("is 0 for an empty conversation and strictly positive otherwise", () => {
    expect(estimateConversationTokens([])).toBe(0);
    expect(estimateConversationTokens([msg("user", "hi"), msg("assistant", "hello")])).toBeGreaterThan(0);
  });
});

describe("trimConversationMessages — default (temporal) budget contract", () => {
  it("leaves the conversation untouched and reports triggeredBy 'none' when comfortably under budget", () => {
    const messages = [msg("user", "hi"), msg("assistant", "hello")];
    const result = trimConversationMessages(messages, { maxContextWindowTokens: 100_000, outputReserveTokens: 1_000 });
    expect(result.removedCount).toBe(0);
    expect(result.triggeredBy).toBe("none");
    expect(result.summaryInserted).toBe(false);
    expect(result.messages).toHaveLength(2);
  });

  it("keeps a conversation whose total EXACTLY equals the budget untouched (the > boundary, not >=)", () => {
    // A fixed estimator pins total == budget exactly: the trim fires on
    // `total > budget`, so an exact fit must stay whole (triggeredBy 'none').
    // A `>`→`>=` regression would needlessly evict from a conversation that fits.
    const estimator = { estimate: (text: string) => (text.length > 0 ? 10 : 0) };
    const messages = [msg("user", "a"), msg("assistant", "b")]; // total = 20 with overhead 0
    const exact = trimConversationMessages(messages, { maxContextWindowTokens: 20, outputReserveTokens: 0, estimator, messageStructureOverhead: 0 });
    expect(exact.triggeredBy).toBe("none");
    expect(exact.removedCount).toBe(0);
    expect(exact.messages).toHaveLength(2);
    // One token over the budget DOES trim — the boundary is real, not inert.
    const over = trimConversationMessages(messages, { maxContextWindowTokens: 19, outputReserveTokens: 0, estimator, messageStructureOverhead: 0 });
    expect(over.triggeredBy).toBe("hard_limit");
    expect(over.removedCount).toBeGreaterThan(0);
  });

  it("under a hard limit (budget ≤ 0) keeps ONLY the last user message", () => {
    const messages = [msg("user", "first"), msg("assistant", "a1"), msg("user", "second question here")];
    const result = trimConversationMessages(messages, { maxContextWindowTokens: 10, outputReserveTokens: 1_000 });
    expect(result.triggeredBy).toBe("hard_limit");
    expect(result.messages.map((m) => m.content)).toEqual(["second question here"]);
    expect(result.removedCount).toBe(2);
  });

  it("over the hard budget drops old history and lands within the budget", () => {
    const messages = longConversation(40);
    const result = trimConversationMessages(messages, { insertSummary: false, maxContextWindowTokens: 400, outputReserveTokens: 50 });
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
    expect(result.triggeredBy).toBe("hard_limit");
  });

  it("fires a PROACTIVE working-budget trim while still under the hard cap", () => {
    const messages = longConversation(30);
    const result = trimConversationMessages(messages, {
      insertSummary: false,
      maxContextWindowTokens: 100_000,
      outputReserveTokens: 1_000,
      workingBudgetTokens: 300
    });
    expect(result.triggeredBy).toBe("working_budget");
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("inserts a [Conversation summary] system message once the dropped count meets the threshold", () => {
    const result = trimConversationMessages(longConversation(40), {
      compactionThreshold: 3,
      maxContextWindowTokens: 400,
      outputReserveTokens: 50
    });
    expect(result.summaryInserted).toBe(true);
    expect(result.messages.some((m) => typeof m.content === "string" && m.content.startsWith(COMPACTION_SUMMARY_PREFIX))).toBe(true);
  });

  it("keeps the conversation within the hard budget even after a compaction summary is inserted", () => {
    // PRE-FIX this overshoots: the trim passes land the conversation AT the hard
    // budget, then insertCompactionSummary adds the summary tokens with no
    // reservation and no re-trim (measured estimatedTokens=414 > budgetTokens=350).
    const messages = [...longConversation(40), msg("user", "FINAL needed question marker")];
    const result = trimConversationMessages(messages, {
      compactionThreshold: 3,
      maxContextWindowTokens: 400,
      outputReserveTokens: 50
    });
    expect(result.summaryInserted).toBe(true);
    expect(result.messages.some((m) => typeof m.content === "string" && m.content.startsWith(COMPACTION_SUMMARY_PREFIX))).toBe(true);
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
    // needed-source survives: the last user turn is never dropped to make room.
    expect(result.messages.at(-1)?.content).toContain("FINAL needed question marker");
  });

  it("removes an orphaned tool message that has no preceding tool call (pair integrity)", () => {
    const messages = [msg("user", "do it"), msg("tool", "orphan result", { toolCallId: "x" }), msg("assistant", "done")];
    const result = trimConversationMessages(messages, { maxContextWindowTokens: 100_000, outputReserveTokens: 100 });
    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
