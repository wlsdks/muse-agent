import { describe, expect, it } from "vitest";

import {
  blockedToolResult,
  planExecuteIntermediateMessages,
  type ExecutedToolResult,
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
