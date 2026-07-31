import { describe, expect, it } from "vitest";

import { InMemoryAgentRunHistoryStore } from "@muse/runtime-state";

import { createLoopControlReceipt, parseLoopControlReceipt } from "./loop-control-receipt.js";
import { checkpointContinuityEvidenceFromMessages, recordRunComplete } from "./lifecycle.js";
import type { AgentRunContext } from "./types.js";

describe("checkpointContinuityEvidenceFromMessages", () => {
  it("uses only the latest user-authored input and bounds it", () => {
    const evidence = checkpointContinuityEvidenceFromMessages([
      { content: "older secret", role: "user" },
      { content: "assistant output", role: "assistant" },
      { content: `  ${"가".repeat(200)}\nlatest request  `, role: "user" },
      { content: "tool secret", name: "tool", role: "tool", toolCallId: "call_1" }
    ], "act");
    expect(evidence?.phase).toBe("act");
    expect(evidence?.query).toContain("가");
    expect(evidence?.query).not.toContain("older secret");
    expect(evidence?.query).not.toContain("assistant output");
    expect(evidence?.query).not.toContain("tool secret");
    expect(new TextEncoder().encode(evidence!.query).byteLength).toBeLessThanOrEqual(240);
  });

  it("omits evidence for unknown phases or missing user input", () => {
    expect(checkpointContinuityEvidenceFromMessages([{ content: "system", role: "system" }], "start")).toBeUndefined();
    expect(checkpointContinuityEvidenceFromMessages([{ content: "request", role: "user" }], "custom")).toBeUndefined();
  });
});

describe("recordRunComplete — durable loop-control evidence", () => {
  it("persists the exact settled receipt beside final tool-call metadata", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    const receipt = createLoopControlReceipt({
      budget: {
        retries: { limit: 2, used: 1 },
        steps: { limit: 8, used: 4 },
        tools: { limit: 4, used: 1 },
        wallclockLimitMs: 10_000
      },
      endedAt: "2026-07-31T08:00:03.000Z",
      loopKind: "react",
      runId: "run-history-1",
      startedAt: "2026-07-31T08:00:00.000Z",
      terminal: { reason: "goal-verified", status: "completed" },
      verification: { evidenceId: "eval:history-1", status: "passed" }
    });
    const context = {
      input: { messages: [], metadata: {}, model: "model" },
      runId: "run-history-1",
      startedAt: new Date("2026-07-31T08:00:00.000Z")
    } as AgentRunContext;

    await recordRunComplete({
      context,
      execution: {
        finalResponse: {
          id: "response-1",
          model: "model",
          output: "done",
          toolCalls: [{ arguments: { query: "safe" }, id: "call-1", name: "search" }]
        },
        intermediateMessages: [],
        toolCallCount: 1,
        toolResults: [],
        toolsUsed: ["search"]
      },
      historyStore,
      loopControlReceipt: receipt,
      resolveToolRisk: () => "read"
    });

    const messages = await historyStore.listMessages(context.runId);
    const final = messages.at(-1);
    expect(final?.metadata).toMatchObject({
      toolCallCount: 1,
      toolCallIds: ["call-1"],
      toolCallNames: ["search"]
    });
    expect(parseLoopControlReceipt(final?.metadata.loopControlReceipt)).toEqual(receipt);
  });

  it("does not invent loop evidence for a cache-only completion", async () => {
    const historyStore = new InMemoryAgentRunHistoryStore();
    const context = {
      input: { messages: [], metadata: {}, model: "model" },
      runId: "run-cache-1",
      startedAt: new Date("2026-07-31T08:00:00.000Z")
    } as AgentRunContext;

    await recordRunComplete({
      context,
      execution: {
        finalResponse: { id: "cached", model: "model", output: "cached" },
        intermediateMessages: [],
        toolCallCount: 0,
        toolResults: [],
        toolsUsed: []
      },
      historyStore,
      resolveToolRisk: () => "read"
    });

    expect((await historyStore.listMessages(context.runId)).at(-1)?.metadata)
      .not.toHaveProperty("loopControlReceipt");
  });
});
