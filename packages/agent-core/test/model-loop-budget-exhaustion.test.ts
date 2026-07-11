import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { budgetExhaustionNotice } from "../src/budget-exhaustion-notice.js";
import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

// Budget-exhaustion notice: when the loop hits maxToolCalls, activeTools is
// forced empty and the notice is injected BEFORE that no-tools call, so the
// SAME turn that would otherwise silently synthesize a final answer sees why
// its tools disappeared — no extra round-trip discarding an already-good
// answer. This drives that path with a SCRIPTED provider and asserts the
// model is actually TOLD it ran out of budget (not just that the wiring
// compiles). Revert anchor: neutralise the toolCallCount>=maxToolCalls gate
// or the one-shot guard → these go RED.

const provider = {} as unknown as ModelProvider;
const tool = { name: "search", description: "search", inputSchema: { type: "object" as const }, risk: "read" as const };

const context = (): AgentRunContext => ({
  runId: "run-budget",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "find it" }] }
});
const request = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "find it" }], tools: [tool] });

const sawNotice = (seen: ModelMessage[][], used: number, limit: number): boolean =>
  seen.some((messages) =>
    messages.some((m) => typeof m.content === "string" && m.content === budgetExhaustionNotice(used, limit))
  );

const anyNotice = (seen: ModelMessage[][]): boolean =>
  seen.some((messages) => messages.some((m) => typeof m.content === "string" && m.content.includes("of your")));

/** A runner that ALWAYS calls the tool with a distinct arg every turn — it never
 * finishes on its own, so the only way the loop stops is the budget cap. */
function alwaysCallingRunner(opts: { maxToolCalls: number; seen: ModelMessage[][] }): ModelLoopRunner {
  let turn = 0;
  return {
    maxToolCalls: opts.maxToolCalls,
    generateWithTracing: async (_ctx: AgentRunContext, _p: ModelProvider, req: ModelRequest): Promise<ModelResponse> => {
      opts.seen.push([...req.messages]);
      const toolsOffered = (req.tools?.length ?? 0) > 0;
      turn += 1;
      if (!toolsOffered) {
        return { id: `fin${turn.toString()}`, model: "m", output: "final answer", toolCalls: [] };
      }
      const c: ModelToolCall = { id: `t${turn.toString()}`, name: "search", arguments: { n: turn } };
      return { id: `x${turn.toString()}`, model: "m", output: "still searching", toolCalls: [c] };
    },
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => ({
      result: { id: toolCall.id, name: toolCall.name, output: `page ${toolCall.arguments.n as number}`, status: "completed" },
      toolCall
    })
  } as unknown as ModelLoopRunner;
}

describe("executeModelLoop — budget-exhaustion notice", () => {
  it("terminates instead of looping forever once the tool budget is exhausted", async () => {
    const seen: ModelMessage[][] = [];
    const result = await executeModelLoop(
      alwaysCallingRunner({ maxToolCalls: 2, seen }),
      context(),
      provider,
      request()
    );
    expect(result.finalResponse.output).toBe("final answer");
    expect(result.finalResponse.toolCalls ?? []).toHaveLength(0);
  });

  it("injects the N/M notice exactly once before the final synthesis turn", async () => {
    const seen: ModelMessage[][] = [];
    await executeModelLoop(alwaysCallingRunner({ maxToolCalls: 2, seen }), context(), provider, request());
    expect(sawNotice(seen, 2, 2)).toBe(true);
    const noticeTurns = seen.filter((messages) =>
      messages.some((m) => typeof m.content === "string" && m.content === budgetExhaustionNotice(2, 2))
    );
    expect(noticeTurns).toHaveLength(1);
  });

  it("does NOT inject the notice on a normal finish before the budget is hit", async () => {
    const seen: ModelMessage[][] = [];
    let turn = 0;
    const runner: ModelLoopRunner = {
      maxToolCalls: 10,
      generateWithTracing: async (_ctx: AgentRunContext, _p: ModelProvider, req: ModelRequest): Promise<ModelResponse> => {
        seen.push([...req.messages]);
        turn += 1;
        if (turn === 1) {
          return { id: "x1", model: "m", output: "acting", toolCalls: [{ id: "t1", name: "search", arguments: {} }] };
        }
        return { id: "fin", model: "m", output: "final answer", toolCalls: [] };
      },
      executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => ({
        result: { id: toolCall.id, name: toolCall.name, output: "one result", status: "completed" },
        toolCall
      })
    } as unknown as ModelLoopRunner;

    const result = await executeModelLoop(runner, context(), provider, request());
    expect(result.finalResponse.output).toBe("final answer");
    expect(anyNotice(seen)).toBe(false);
  });

  it("does NOT inject the budget notice when the halt is a no-progress stall, not the budget", async () => {
    // Mirrors model-loop-stall.test.ts: identical tool output every turn stalls
    // the loop (activeTools forced empty) well before maxToolCalls is reached —
    // toolCallCount stays BELOW the cap, so the strict `>= maxToolCalls` gate
    // must not fire even though activeTools is empty for the same reason.
    const seen: ModelMessage[][] = [];
    let turn = 0;
    const runner: ModelLoopRunner = {
      maxToolCalls: 10,
      generateWithTracing: async (_ctx: AgentRunContext, _p: ModelProvider, req: ModelRequest): Promise<ModelResponse> => {
        seen.push([...req.messages]);
        const toolsOffered = (req.tools?.length ?? 0) > 0;
        turn += 1;
        if (!toolsOffered) {
          return { id: "fin", model: "m", output: "final answer", toolCalls: [] };
        }
        const c: ModelToolCall = { id: `t${turn.toString()}`, name: "search", arguments: { n: turn } };
        return { id: `x${turn.toString()}`, model: "m", output: "still searching", toolCalls: [c] };
      },
      executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => ({
        // identical output every call → the stall tracker trips well under maxToolCalls (10)
        result: { id: toolCall.id, name: toolCall.name, output: "results: alpha beta gamma delta", status: "completed" },
        toolCall
      })
    } as unknown as ModelLoopRunner;

    const result = await executeModelLoop(runner, context(), provider, request());
    expect(result.finalResponse.output).toBe("final answer");
    expect(anyNotice(seen)).toBe(false);
  });
});
