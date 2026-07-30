import { describe, expect, it } from "vitest";

import { toAdminRunSummary, toCompatChatResponse, toExtendedChatResponse } from "../src/server-chat-response-builders.js";
import { createLoopControlReceipt, type AgentRunResult } from "@muse/agent-core";
import type { AgentRunRecord } from "@muse/runtime-state";

const result = (over: Record<string, unknown> = {}, responseOver: Record<string, unknown> = {}): AgentRunResult =>
  ({
    contextWindow: undefined,
    fromCache: true,
    response: { citations: [{ url: "u" }], model: "qwen3:8b", output: "answer", usage: { inputTokens: 10, outputTokens: 5 }, ...responseOver },
    runId: "r1",
    toolsUsed: ["t"],
    ...over
  }) as unknown as AgentRunResult;

describe("toCompatChatResponse", () => {
  it("maps content, model, citations, toolsUsed, and a success envelope", () => {
    const r = toCompatChatResponse(result());
    expect(r).toMatchObject({
      citations: [{ url: "u" }],
      content: "answer",
      model: "qwen3:8b",
      success: true,
      toolsUsed: ["t"]
    });
  });

  it("always reports blockReason / grounded / verifiedSourceCount as null on this path", () => {
    const r = toCompatChatResponse(result());
    expect(r.blockReason).toBeNull();
    expect(r.grounded).toBeNull();
    expect(r.verifiedSourceCount).toBeNull();
    expect(r.errorCode).toBeNull();
    expect(r.errorMessage).toBeNull();
    expect(r.durationMs).toBeNull();
  });

  it("defaults citations and toolsUsed to empty arrays", () => {
    const r = toCompatChatResponse(result({ toolsUsed: undefined }, { citations: undefined }));
    expect(r.citations).toEqual([]);
    expect(r.toolsUsed).toEqual([]);
  });

  describe("tokenUsage", () => {
    it("is null when the response has no usage", () => {
      expect(toCompatChatResponse(result({}, { usage: undefined })).tokenUsage).toBeNull();
    });

    it("sums prompt + completion (missing counts default to 0)", () => {
      expect(toCompatChatResponse(result({}, { usage: { inputTokens: 7 } })).tokenUsage).toEqual({
        cachedContentTokens: null,
        completionTokens: 0,
        promptTokens: 7,
        thoughtsTokens: null,
        toolUsePromptTokens: null,
        totalTokens: 7,
        trafficType: null
      });
    });

    it("maps cachedInputTokens -> cachedContentTokens and reasoningTokens -> thoughtsTokens", () => {
      expect(toCompatChatResponse(result({}, { usage: { cachedInputTokens: 3, inputTokens: 1, outputTokens: 2, reasoningTokens: 4 } })).tokenUsage).toMatchObject({
        cachedContentTokens: 3,
        completionTokens: 2,
        promptTokens: 1,
        thoughtsTokens: 4,
        totalTokens: 3
      });
    });
  });

  describe("metadata", () => {
    it("carries only fromCache + runId when there is no agentSpec/contextWindow", () => {
      expect(toCompatChatResponse(result()).metadata).toEqual({ fromCache: true, runId: "r1" });
    });

    it("includes agentSpec and contextWindow projections when present", () => {
      const r = toCompatChatResponse(
        result({
          agentSpec: { confidence: 0.9, matchedKeywords: ["a"], name: "spec", toolNames: ["t1"] },
          contextWindow: { budgetTokens: 100, estimatedTokens: 20, removedCount: 1, summaryInserted: true }
        })
      );
      expect(r.metadata).toEqual({
        agentSpec: { confidence: 0.9, matchedKeywords: ["a"], name: "spec", toolNames: ["t1"] },
        contextWindow: { budgetTokens: 100, estimatedTokens: 20, removedCount: 1, summaryInserted: true },
        fromCache: true,
        runId: "r1"
      });
    });

    it("surfaces health only from a verified loop control receipt", () => {
      const loopControlReceipt = createLoopControlReceipt({
        budget: { retries: null, steps: null, tools: null, wallclockLimitMs: 10_000 },
        endedAt: "2026-07-30T00:00:03.000Z",
        loopKind: "react",
        runId: "r1",
        startedAt: "2026-07-30T00:00:00.000Z",
        terminal: { reason: "goal-verified", status: "completed" },
        verification: { evidenceId: "eval:chat-1", status: "passed" }
      });

      expect(toCompatChatResponse(result({ fromCache: false, loopControlReceipt })).metadata.loopHealth).toEqual({
        endedAt: "2026-07-30T00:00:03.000Z",
        terminalReason: "goal-verified",
        terminalStatus: "completed",
        verificationEvidenceId: "eval:chat-1",
        verificationStatus: "passed"
      });
      expect(toCompatChatResponse(result()).metadata).not.toHaveProperty("loopHealth");
      expect(toCompatChatResponse(result({ loopControlReceipt })).metadata).not.toHaveProperty("loopHealth");
      expect(toCompatChatResponse(result({
        fromCache: false,
        loopControlReceipt: { ...loopControlReceipt, runId: "tampered" }
      })).metadata).not.toHaveProperty("loopHealth");
    });
  });
});

describe("toExtendedChatResponse", () => {
  it("extends the compat shape with response/runId/usage/fromCache/contextWindow", () => {
    const r = toExtendedChatResponse(
      result({ contextWindow: { budgetTokens: 1 } }) as AgentRunResult
    ) as Record<string, unknown>;
    expect(r.content).toBe("answer");
    expect(r.response).toBe("answer");
    expect(r.runId).toBe("r1");
    expect(r.fromCache).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(r.contextWindow).toEqual({ budgetTokens: 1 });
  });

  it("defaults fromCache to false when absent", () => {
    expect((toExtendedChatResponse(result({ fromCache: undefined })) as { fromCache: boolean }).fromCache).toBe(false);
  });
});

describe("toAdminRunSummary", () => {
  const record = (input: string): AgentRunRecord =>
    ({ id: "run-id", input, model: "qwen3:8b", provider: "ollama", status: "completed" }) as unknown as AgentRunRecord;

  it("projects id/model/provider/status and a normalized input preview", () => {
    expect(toAdminRunSummary(record("  hello   world  "))).toEqual({
      id: "run-id",
      inputPreview: "hello world",
      model: "qwen3:8b",
      provider: "ollama",
      status: "completed"
    });
  });

  it("collapses all whitespace runs to single spaces", () => {
    expect(toAdminRunSummary(record("a\n\tb   c")).inputPreview).toBe("a b c");
  });

  it("leaves a preview at or below 120 chars untouched", () => {
    const exact = "x".repeat(120);
    expect(toAdminRunSummary(record(exact)).inputPreview).toBe(exact);
  });

  it("truncates a longer preview to 120 chars ending in an ellipsis", () => {
    const preview = toAdminRunSummary(record("y".repeat(200))).inputPreview;
    expect(preview).toHaveLength(120);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.slice(0, 119)).toBe("y".repeat(119));
  });
});
