/**
 * Tests for the salient-fact persistence in persistConversationSummaryFromRequest
 * and the assembled-path (trim → persist → reinject) round-trip.
 *
 * Grounded in arXiv:2511.17208: verbatim user-stated details (numbers,
 * amounts) must survive compaction into the re-injected system message
 * the next turn sees.
 */
import {
  COMPACTION_SUMMARY_PREFIX,
  InMemoryConversationSummaryStore,
  trimConversationMessages,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationSummaryStore,
  type StructuredFact
} from "@muse/memory";
import { describe, expect, it } from "vitest";

import {
  applyStoredConversationSummary,
  persistConversationSummaryFromRequest
} from "../src/context-transforms.js";
import type { AgentRunContext } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const est = { estimate: (t: string) => (t ?? "").length };

const m = (
  role: ConversationMessage["role"],
  content: string,
  extra: Partial<ConversationMessage> = {}
): ConversationMessage => ({ content, role, ...extra });

function makeContext(sessionId: string, messages: readonly ConversationMessage[] = []): AgentRunContext {
  return {
    runId: "r1",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    input: { model: "test", messages, metadata: { sessionId } }
  };
}

// ---------------------------------------------------------------------------
// Persist no-wipe: facts in the store survive a subsequent persist call
// ---------------------------------------------------------------------------

describe("persistConversationSummaryFromRequest — persist no-wipe", () => {
  it("merges prior stored facts with new facts (does NOT wipe to [])", async () => {
    const store = new InMemoryConversationSummaryStore();

    // Pre-seed the store with an existing fact.
    const priorFact: StructuredFact = { key: "prior_budget", value: "500만원", category: "NUMERIC" };
    await store.save({
      sessionId: "sess-facts",
      narrative: `${COMPACTION_SUMMARY_PREFIX}: 2 messages compacted]`,
      facts: [priorFact],
      summarizedUpToIndex: 2
    });

    // Build a compaction summary message that contains a new fact via [Key details].
    const summaryWithNewFact = [
      m("system",
        `${COMPACTION_SUMMARY_PREFIX}: 3 messages compacted]\n[Key details]\n• [NUMERIC] marketing_budget: 마케팅 예산 1,250만원`)
    ];
    const ctx = makeContext("sess-facts", summaryWithNewFact);

    await persistConversationSummaryFromRequest(
      ctx,
      { messages: summaryWithNewFact },
      5,
      store
    );

    const saved = await store.get("sess-facts");
    expect(saved).toBeDefined();
    expect(saved!.facts).toBeDefined();
    // Both the old fact AND the new one must be present.
    const keys = (saved!.facts ?? []).map((f) => f.key);
    expect(keys).toContain("prior_budget");
    expect(keys).toContain("marketing_budget");
    expect((saved!.facts ?? []).length).toBeGreaterThan(1);
  });

  it("fails open: a store.get error does not prevent save", async () => {
    // A store whose get() throws but save() works.
    let savedNarrative = "";
    const faultyStore: ConversationSummaryStore = {
      get: async () => { throw new Error("db error"); },
      save: async (s) => {
        savedNarrative = s.narrative;
        return s as ConversationSummary;
      }
    };

    const summaryMsg = [m("system", `${COMPACTION_SUMMARY_PREFIX}: 2 messages compacted]`)];
    const ctx = makeContext("sess-err", summaryMsg);

    // Should not throw; save should still happen.
    await expect(
      persistConversationSummaryFromRequest(ctx, { messages: summaryMsg }, 2, faultyStore)
    ).resolves.toBeUndefined();

    expect(savedNarrative).toContain(COMPACTION_SUMMARY_PREFIX);
  });

  it("is a no-op when the head message is not a compaction summary", async () => {
    const store = new InMemoryConversationSummaryStore();
    const msgs = [m("user", "hello")];
    const ctx = makeContext("sess-noop", msgs);

    await persistConversationSummaryFromRequest(ctx, { messages: msgs }, 0, store);

    const saved = await store.get("sess-noop");
    expect(saved).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Assembled-path: trim → persist → reinject (the number survives)
// ---------------------------------------------------------------------------

describe("assembled-path: trim → persist → reinject", () => {
  it("a number from a compacted-out turn survives into the re-injected system message", async () => {
    const store = new InMemoryConversationSummaryStore();
    const sessionId = "sess-assembled";

    // Build a conversation long enough to trigger compaction.
    // Each filler turn is ~20 chars; 8 pairs = ~320 chars total, well over
    // the 100-token budget so the trimmer is forced to compact.
    const longConv: ConversationMessage[] = [m("system", "You are a helpful assistant.")];
    for (let i = 0; i < 8; i++) {
      longConv.push(m("user", i === 0 ? "마케팅 예산은 1,250만원으로 확정했습니다." : `일반 메시지 입니다 ${i}번`));
      longConv.push(m("assistant", `네, 알겠습니다 응답 번호 ${i}`));
    }
    longConv.push(m("user", "what is the budget?"));

    // Step 1: trim using the REAL runtime contextWindow options shape.
    // Budget 100 is well below total (~320 chars), forcing compaction.
    const trimResult = trimConversationMessages(longConv, {
      compactionThreshold: 3,
      estimator: est,
      insertSummary: true,
      maxContextWindowTokens: 100,
      messageStructureOverhead: 0,
      outputReserveTokens: 0
    });

    expect(trimResult.summaryInserted).toBe(true);

    // Step 2: persist — flow through the real persistConversationSummaryFromRequest.
    const ctx = makeContext(sessionId, trimResult.messages as ConversationMessage[]);
    await persistConversationSummaryFromRequest(
      ctx,
      { messages: trimResult.messages },
      trimResult.removedCount,
      store
    );

    // Confirm the store has the narrative.
    const stored = await store.get(sessionId);
    expect(stored).toBeDefined();

    // Step 3: reinject — flow through the real applyStoredConversationSummary.
    // Simulate a fresh context (no compaction summary yet, new turn).
    const nextTurnMessages: ConversationMessage[] = [m("user", "can you confirm the budget?")];
    const nextCtx = makeContext(sessionId, nextTurnMessages);
    const reinjected = await applyStoredConversationSummary(nextCtx, store);

    // The number must appear in the re-injected system message.
    const systemMsg = reinjected.messages.find((x) => x.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain("1,250만원");
  });
});
