import { describe, expect, it } from "vitest";

import { DiagnosticModelProvider, type ModelMessage, type ModelRequest, type ModelEvent } from "@muse/model";
import { COMPACTION_SUMMARY_PREFIX, type ConversationMessage } from "@muse/memory";

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
