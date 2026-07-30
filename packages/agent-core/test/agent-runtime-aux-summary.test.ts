import { describe, expect, it } from "vitest";

import { DiagnosticModelProvider, type ModelMessage, type ModelRequest, type ModelEvent } from "@muse/model";
import type { CachedResponse, ResponseCache } from "@muse/cache";
import { COMPACTION_SUMMARY_PREFIX, type ConversationMessage } from "@muse/memory";
import { InMemoryMuseTracer } from "@muse/observability";
import { retry } from "@muse/resilience";

import { AgentRuntime, augmentCompactionSummary } from "../src/index.js";

describe("augmentCompactionSummary (pure)", () => {
  const summaryMsg: ModelMessage = { content: `${COMPACTION_SUMMARY_PREFIX}: 4 messages compacted]`, role: "system" };

  it("appends the aux summary to the compaction-summary message, preserving the original", () => {
    const out = augmentCompactionSummary([summaryMsg, { content: "hi", role: "user" }], "user discussed vacation plans");
    expect(out[0]!.content).toBe(`${summaryMsg.content}\n[Dropped-context summary: user discussed vacation plans]`);
    expect(out[1]).toEqual({ content: "hi", role: "user" }); // other messages untouched
  });

  it("is a no-op when the aux summary is blank", () => {
    const msgs = [summaryMsg];
    expect(augmentCompactionSummary(msgs, "   ")).toBe(msgs);
  });

  it("is a no-op when there is no compaction-summary message", () => {
    const msgs: ModelMessage[] = [{ content: "regular system prompt", role: "system" }, { content: "hi", role: "user" }];
    expect(augmentCompactionSummary(msgs, "aux")).toBe(msgs);
  });
});

class CapturingDiagnostic extends DiagnosticModelProvider {
  readonly captured: ModelMessage[][] = [];
  override async generate(request: ModelRequest) {
    this.captured.push([...request.messages]);
    return super.generate(request);
  }
  override async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.captured.push([...request.messages]);
    yield* super.stream(request);
  }
}

function compactingMessages(): ConversationMessage[] {
  const msgs: ConversationMessage[] = [];
  for (let i = 0; i < 16; i += 1) {
    msgs.push({ content: `older turn content number ${(i + 1).toString()} with some length`, role: i % 2 === 0 ? "user" : "assistant" });
  }
  msgs.push({ content: "the latest question", role: "user" });
  return msgs;
}

describe("CMP-2 runtime wiring", () => {
  it("emits one bounded compaction event before both uncached and cached model output", async () => {
    let cacheReads = 0;
    const cachedResponse: CachedResponse = {
      cachedAt: 0,
      content: "cached response",
      metadata: {},
      model: "diagnostic/smoke",
      toolsUsed: []
    };
    const responseCache: ResponseCache = {
      get: () => {
        cacheReads += 1;
        return cacheReads === 1 ? undefined : cachedResponse;
      },
      invalidateAll: () => {},
      put: () => {}
    };
    const provider = new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" });
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      modelProvider: provider,
      responseCache
    });
    const input = {
      messages: compactingMessages(),
      model: "diagnostic/smoke",
      runId: "compaction-notice"
    };

    const collect = async () => {
      const events = [];
      for await (const event of runtime.stream(input)) events.push(event);
      return events;
    };
    const uncached = await collect();
    const capturesAfterUncached = provider.captured.length;
    const cached = await collect();

    for (const events of [uncached, cached]) {
      expect(events[0]).toEqual({
        removedCount: expect.any(Number),
        runId: "compaction-notice",
        type: "context-compacted"
      });
      expect(events.filter((event) => event.type === "context-compacted")).toHaveLength(1);
    }
    expect(cached.at(-1)).toMatchObject({ type: "done" });
    expect(provider.captured).toHaveLength(capturesAfterUncached);
  });

  it("does not emit a compaction event when the request fits", async () => {
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      modelProvider: new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" })
    });
    const events = [];
    for await (const event of runtime.stream({
      messages: [{ content: "short", role: "user" }],
      model: "diagnostic/smoke"
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.type === "context-compacted")).toBe(false);
  });

  it("scopes only auxiliary summarization to the foreground run retry ledger", async () => {
    const tracer = new InMemoryMuseTracer();
    let calls = 0;
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      contextSummarizer: () => retry(
        () => {
          calls += 1;
          if (calls === 1) throw new Error("transient aux failure");
          return Promise.resolve("aux recap with the older facts");
        },
        { initialDelayMs: 2, maxAttempts: 2, maxDelayMs: 2, sleep: async () => {} }
      ),
      modelProvider: new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" }),
      runRetryBudget: { maxBackoffMs: 10, maxRetries: 1 },
      tracer
    });

    await runtime.run({ messages: compactingMessages(), model: "diagnostic/smoke" });

    expect(calls).toBe(2);
    const runSpan = tracer.recordedSpans().find((span) => span.name === "muse.agent.run");
    expect(runSpan?.attributes).toMatchObject({
      "retry.budget.used_backoff_ms": 2,
      "retry.budget.used_retries": 1
    });
  });

  it("passes cancellation into auxiliary summarization and terminates before primary dispatch", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancel compacting run");
    const provider = new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" });
    let seenSignal: AbortSignal | undefined;
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      contextSummarizer: async (_dropped, options) => {
        seenSignal = options?.signal;
        controller.abort(cancellation);
        throw cancellation;
      },
      modelProvider: provider
    });

    await expect(runtime.run({
      messages: compactingMessages(),
      model: "diagnostic/smoke",
      signal: controller.signal
    })).rejects.toBe(cancellation);
    expect(seenSignal).toBe(controller.signal);
    expect(provider.captured).toHaveLength(0);
  });

  it("shares one retry cap across every staged auxiliary chunk", async () => {
    const tracer = new InMemoryMuseTracer();
    let chunks = 0;
    let physicalCalls = 0;
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 80, outputReserveTokens: 10 },
      contextSummarizer: () => {
        chunks += 1;
        let attempt = 0;
        return retry(
          () => {
            attempt += 1;
            physicalCalls += 1;
            if (attempt === 1) throw new Error("transient per chunk");
            return Promise.resolve(`chunk ${chunks.toString()} recap`);
          },
          { initialDelayMs: 1, maxAttempts: 2, maxDelayMs: 1, sleep: async () => {} }
        );
      },
      modelProvider: new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" }),
      runRetryBudget: { maxBackoffMs: 10, maxRetries: 1 },
      tracer
    });
    const messages: ConversationMessage[] = Array.from({ length: 8 }, (_, index) => ({
      content: `old-${index.toString()}-${"x".repeat(3_000)}`,
      role: index % 2 === 0 ? "user" : "assistant"
    }));
    messages.push({ content: "latest", role: "user" });

    await runtime.run({ messages, model: "diagnostic/smoke" });

    expect(chunks).toBeGreaterThan(1);
    expect(physicalCalls).toBe(chunks + 1);
    const runSpan = tracer.recordedSpans().find((span) => span.name === "muse.agent.run");
    expect(runSpan?.attributes).toMatchObject({
      "retry.budget.used_backoff_ms": 1,
      "retry.budget.used_retries": 1
    });
  });

  it("appends an aux dropped-context summary when a compaction fires and a summarizer is configured", async () => {
    const provider = new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" });
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      contextSummarizer: async (dropped) => `aux recap of ${dropped.length.toString()} dropped messages`,
      modelProvider: provider
    });

    const result = await runtime.run({ messages: compactingMessages(), metadata: { sessionId: "s1", userId: "u1" }, model: "diagnostic/smoke" });

    expect(result.contextWindow?.summaryInserted).toBe(true);
    const sent = provider.captured[0] ?? [];
    const summary = sent.find((m) => typeof m.content === "string" && m.content.startsWith(COMPACTION_SUMMARY_PREFIX));
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("[Dropped-context summary: aux recap of");
  });

  it("does NOT add an aux summary when no summarizer is configured (opt-in; byte-identical path)", async () => {
    const provider = new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" });
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      modelProvider: provider
    });

    const result = await runtime.run({ messages: compactingMessages(), metadata: { sessionId: "s2", userId: "u1" }, model: "diagnostic/smoke" });

    expect(result.contextWindow?.summaryInserted).toBe(true);
    const sent = provider.captured[0] ?? [];
    expect(sent.some((m) => typeof m.content === "string" && m.content.includes("[Dropped-context summary:"))).toBe(false);
  });
});

describe("CMP-2 fail-close aux-summary quality gate", () => {
  function messagesWithHardAnchor(): ConversationMessage[] {
    const msgs: ConversationMessage[] = [];
    msgs.push({ content: 'the invoice for "Ironclad" is $12,345, due 2026-07-07', role: "user" });
    for (let i = 0; i < 14; i += 1) {
      msgs.push({ content: `older turn content number ${(i + 1).toString()} with some length`, role: i % 2 === 0 ? "assistant" : "user" });
    }
    msgs.push({ content: "the latest question", role: "user" });
    return msgs;
  }

  it("does NOT append an aux summary that drops the user's own hard anchors (fail-close)", async () => {
    const provider = new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" });
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      // A lossy aux summary that drops the invoice name/amount/date entirely.
      contextSummarizer: async () => "we discussed some old turns",
      modelProvider: provider
    });

    const result = await runtime.run({ messages: messagesWithHardAnchor(), metadata: { sessionId: "s3", userId: "u1" }, model: "diagnostic/smoke" });

    expect(result.contextWindow?.summaryInserted).toBe(true);
    const sent = provider.captured[0] ?? [];
    // the deterministic [Key details] floor is still there…
    const summary = sent.find((m) => typeof m.content === "string" && m.content.startsWith(COMPACTION_SUMMARY_PREFIX));
    expect(summary).toBeDefined();
    // …but the lossy aux recap was rejected, not appended on top of it.
    expect(summary!.content).not.toContain("[Dropped-context summary:");
  });

  it("DOES append an aux summary that preserves the hard anchors", async () => {
    const provider = new CapturingDiagnostic({ defaultModel: "diagnostic/smoke" });
    const runtime = new AgentRuntime({
      contextWindow: { maxContextWindowTokens: 60, outputReserveTokens: 10 },
      contextSummarizer: async () => 'discussed the "Ironclad" invoice: $12,345, due 2026-07-07.',
      modelProvider: provider
    });

    const result = await runtime.run({ messages: messagesWithHardAnchor(), metadata: { sessionId: "s4", userId: "u1" }, model: "diagnostic/smoke" });

    expect(result.contextWindow?.summaryInserted).toBe(true);
    const sent = provider.captured[0] ?? [];
    const summary = sent.find((m) => typeof m.content === "string" && m.content.startsWith(COMPACTION_SUMMARY_PREFIX));
    expect(summary).toBeDefined();
    expect(summary!.content).toContain("[Dropped-context summary:");
    expect(summary!.content).toContain("Ironclad");
  });
});
