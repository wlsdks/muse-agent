import { describe, expect, it } from "vitest";

import type { AgentSpec, AgentSpecResolution } from "@muse/agent-specs";
import type { ModelResponse } from "@muse/model";

import {
  blockedToolResult,
  createRunResult,
  planExecuteIntermediateMessages,
  responseFilterEvidenceFromExecution,
  type ExecutedToolResult,
  type ModelLoopExecution,
  type PlanExecuteStepRecord
} from "../src/runtime-internals.js";

describe("blockedToolResult", () => {
  it("synthesises a blocked-status ExecutedToolResult that preserves the tool call", () => {
    const blocked = blockedToolResult(
      { args: { foo: "bar" }, id: "call-42", name: "search" },
      "Error: tool was not exposed"
    );
    expect(blocked).toEqual({
      result: {
        id: "call-42",
        name: "search",
        output: "Error: tool was not exposed",
        status: "blocked"
      },
      toolCall: { args: { foo: "bar" }, id: "call-42", name: "search" }
    });
  });
});

describe("planExecuteIntermediateMessages", () => {
  function makeRecord(
    callId: string,
    toolName: string,
    output: string
  ): PlanExecuteStepRecord {
    const executed: ExecutedToolResult = {
      result: { id: callId, name: toolName, output, status: "completed" },
      toolCall: { args: {}, id: callId, name: toolName }
    };
    return {
      executed,
      step: { args: {}, description: `step using ${toolName}`, tool: toolName },
      stepResult: { description: `step ${toolName}`, output, success: true, tool: toolName }
    };
  }

  it("emits one assistant message + one tool message per executed step", () => {
    const messages = planExecuteIntermediateMessages(
      [
        { args: { q: "muse" }, description: "find docs", tool: "search" },
        { args: {}, description: "summarise", tool: "summarise" }
      ],
      [makeRecord("call-1", "search", "found 3 hits"), makeRecord("call-2", "summarise", "tldr")]
    );

    expect(messages).toHaveLength(3);
    const [planMessage, toolA, toolB] = messages;
    expect(planMessage?.role).toBe("assistant");
    expect(planMessage?.toolCalls).toEqual([
      { args: {}, id: "call-1", name: "search" },
      { args: {}, id: "call-2", name: "summarise" }
    ]);
    expect(JSON.parse(planMessage?.content ?? "")).toEqual([
      { args: { q: "muse" }, description: "find docs", tool: "search" },
      { args: {}, description: "summarise", tool: "summarise" }
    ]);

    expect(toolA).toMatchObject({
      content: "found 3 hits",
      name: "search",
      role: "tool",
      toolCallId: "call-1"
    });
    expect(toolB).toMatchObject({
      content: "tldr",
      name: "summarise",
      role: "tool",
      toolCallId: "call-2"
    });
  });

  it("preserves toolCalls + tool messages for the empty-record case", () => {
    const messages = planExecuteIntermediateMessages([], []);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ content: "[]", role: "assistant", toolCalls: [] });
  });
});

const sampleSpec: AgentSpec = {
  createdAt: new Date(),
  description: "sample",
  enabled: true,
  id: "spec-1",
  independentExecution: true,
  keywords: ["alpha"],
  mode: "react",
  name: "Sample",
  systemPrompt: "You are sample.",
  toolNames: ["search"],
  updatedAt: new Date()
};

const sampleResolution: AgentSpecResolution = {
  confidence: 0.5,
  matchedKeywords: ["alpha"],
  spec: sampleSpec
};

const sampleResponse: ModelResponse = {
  id: "r-1",
  model: "diagnostic/smoke",
  output: "ok"
};

describe("createRunResult", () => {
  it("returns the minimum shape (response + runId) when no extras are supplied", () => {
    expect(createRunResult("run-1", sampleResponse, undefined, undefined)).toEqual({
      response: sampleResponse,
      runId: "run-1"
    });
  });

  it("attaches contextWindow when supplied", () => {
    const window = { budgetTokens: 8000, estimatedTokens: 100, removedCount: 0, summaryInserted: false };
    expect(createRunResult("run-2", sampleResponse, window, undefined)).toEqual({
      contextWindow: window,
      response: sampleResponse,
      runId: "run-2"
    });
  });

  it("attaches the agentSpec report when a resolution is supplied", () => {
    const result = createRunResult("run-3", sampleResponse, undefined, sampleResolution);
    expect(result.agentSpec).toEqual({
      confidence: 0.5,
      matchedKeywords: ["alpha"],
      name: "Sample",
      toolNames: ["search"]
    });
  });

  it("includes both agentSpec and contextWindow when both are supplied", () => {
    const window = { budgetTokens: 8000, estimatedTokens: 100, removedCount: 0, summaryInserted: false };
    const result = createRunResult("run-4", sampleResponse, window, sampleResolution);
    expect(result.contextWindow).toEqual(window);
    expect(result.agentSpec?.name).toBe("Sample");
  });

  it("only sets fromCache when the flag is true", () => {
    const cached = createRunResult("run-5", sampleResponse, undefined, undefined, { fromCache: true });
    expect(cached.fromCache).toBe(true);
    const fresh = createRunResult("run-6", sampleResponse, undefined, undefined, { fromCache: false });
    expect(fresh.fromCache).toBeUndefined();
  });

  it("only sets toolsUsed when the array is non-empty", () => {
    const used = createRunResult("run-7", sampleResponse, undefined, undefined, { toolsUsed: ["search"] });
    expect(used.toolsUsed).toEqual(["search"]);
    const none = createRunResult("run-8", sampleResponse, undefined, undefined, { toolsUsed: [] });
    expect(none.toolsUsed).toBeUndefined();
  });
});

describe("responseFilterEvidenceFromExecution", () => {
  it("returns empty arrays when there are no tool results", () => {
    const evidence = responseFilterEvidenceFromExecution({
      finalResponse: sampleResponse,
      intermediateMessages: [],
      toolResults: [],
      toolsUsed: []
    });
    expect(evidence).toEqual({
      toolInsights: [],
      toolsUsed: [],
      verifiedSources: []
    });
  });

  it("dedupes verified sources by canonical URL across multiple tool calls", () => {
    const execution: ModelLoopExecution = {
      finalResponse: sampleResponse,
      intermediateMessages: [],
      toolResults: [
        {
          result: {
            id: "t-1",
            name: "web_search",
            output: "see https://example.com/page#frag",
            status: "completed"
          },
          toolCall: { args: {}, id: "t-1", name: "web_search" }
        },
        {
          result: {
            id: "t-2",
            name: "web_search",
            output: "see https://example.com/page/",
            status: "completed"
          },
          toolCall: { args: {}, id: "t-2", name: "web_search" }
        }
      ],
      toolsUsed: ["web_search"]
    };
    const evidence = responseFilterEvidenceFromExecution(execution);
    expect(evidence.verifiedSources).toHaveLength(1);
    expect(evidence.toolsUsed).toEqual(["web_search"]);
  });

  it("flattens insights and dedupes them", () => {
    const evidence = responseFilterEvidenceFromExecution({
      finalResponse: sampleResponse,
      intermediateMessages: [],
      toolResults: [
        {
          result: {
            id: "t-1",
            name: "search",
            output: JSON.stringify({ insights: ["alpha", "beta"] }),
            status: "completed"
          },
          toolCall: { args: {}, id: "t-1", name: "search" }
        },
        {
          result: {
            id: "t-2",
            name: "search",
            output: JSON.stringify({ insights: ["beta", "gamma"] }),
            status: "completed"
          },
          toolCall: { args: {}, id: "t-2", name: "search" }
        }
      ],
      toolsUsed: ["search"]
    });
    expect(evidence.toolInsights).toEqual(["alpha", "beta", "gamma"]);
  });
});
