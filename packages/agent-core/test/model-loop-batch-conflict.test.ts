import type { ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

// Intra-batch conflicting-write guard (AgentSpec arXiv:2503.18666): when one turn
// emits two conflicting writes to the same target, only the first runs — the
// second is withheld (zero side-effect), a write actuator double-act prevented.

const provider = {} as unknown as ModelProvider;
const writeTool = { name: "calendar_add", description: "add", inputSchema: { type: "object" as const }, risk: "write" as const };
const readTool = { name: "web_search", description: "search", inputSchema: { type: "object" as const }, risk: "read" as const };

const context = (): AgentRunContext => ({
  runId: "run-batch-conflict",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "schedule it" }] }
});
const request = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "schedule it" }], tools: [writeTool, readTool] });

/**
 * Runner that emits a given batch on turn 1, then a final answer. `executeToolCall`
 * records each call it actually runs (so the test can assert which writes reached
 * the actuator). status always "completed".
 */
function batchRunner(batch: readonly ModelToolCall[], ran: ModelToolCall[]): ModelLoopRunner {
  let turn = 0;
  return {
    maxToolCalls: 10,
    generateWithTracing: async (_ctx: AgentRunContext, _p: ModelProvider, _req: ModelRequest): Promise<ModelResponse> => {
      turn += 1;
      if (turn === 1) return { id: "x1", model: "m", output: "working", toolCalls: [...batch] };
      return { id: "fin", model: "m", output: "done", toolCalls: [] };
    },
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
      ran.push(toolCall);
      return { result: { id: toolCall.id, name: toolCall.name, output: "ok", status: "completed" }, toolCall };
    }
  } as unknown as ModelLoopRunner;
}

const tc = (id: string, name: string, args: Record<string, unknown>): ModelToolCall => ({ id, name, arguments: args as ModelToolCall["arguments"] });

describe("executeModelLoop — intra-batch conflicting-write guard (AgentSpec arXiv:2503.18666)", () => {
  it("runs only the FIRST of two conflicting same-target writes; a read in the batch still runs", async () => {
    const ran: ModelToolCall[] = [];
    const result = await executeModelLoop(
      batchRunner([
        tc("c1", "calendar_add", { title: "Standup", startsAt: "3pm" }),
        tc("c2", "calendar_add", { title: "Standup", startsAt: "4pm" }), // conflicting double-act
        tc("c3", "web_search", { query: "agenda" })
      ], ran),
      context(),
      provider,
      request()
    );
    const ranWrites = ran.filter((c) => c.name === "calendar_add");
    expect(ranWrites).toHaveLength(1); // exactly ONE write reached the actuator
    expect(ranWrites[0]!.arguments).toMatchObject({ startsAt: "3pm" }); // the first, not the 4pm conflict
    expect(ran.some((c) => c.name === "web_search")).toBe(true); // the read still ran
    expect(result.finalResponse.output).toBe("done");
  });

  it("does NOT block two writes to DIFFERENT targets (both run — no over-block)", async () => {
    const ran: ModelToolCall[] = [];
    await executeModelLoop(
      batchRunner([
        tc("c1", "calendar_add", { title: "Mon Standup", startsAt: "9am" }),
        tc("c2", "calendar_add", { title: "Tue Review", startsAt: "10am" })
      ], ran),
      context(),
      provider,
      request()
    );
    expect(ran.filter((c) => c.name === "calendar_add")).toHaveLength(2); // different events → both run
  });
});
