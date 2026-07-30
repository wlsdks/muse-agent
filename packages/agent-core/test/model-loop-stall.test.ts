import type { ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

const provider = {} as unknown as ModelProvider;
const tool = { name: "search", description: "search", inputSchema: { type: "object" as const }, risk: "read" as const };

const context = (): AgentRunContext => ({
  runId: "run-stall",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "find it" }] }
});
const request = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "find it" }], tools: [tool] });

// A runner that, while tools are offered, keeps requesting `search` with a UNIQUE
// arg each turn (so the exact-signature deduplicator never collapses them — they
// genuinely execute). `executeToolCall` returns `toolOutput(callIndex)`. When the
// loop withholds tools (activeTools=[]), the model returns a final synthesis.
function stallRunner(opts: {
  toolOutput: (n: number) => string;
  maxToolCalls: number;
  ran: number[];
}): ModelLoopRunner {
  let turn = 0;
  let execCount = 0;
  return {
    maxToolCalls: opts.maxToolCalls,
    generateWithTracing: async (_ctx: AgentRunContext, _p: ModelProvider, req: ModelRequest): Promise<ModelResponse> => {
      const toolsOffered = (req.tools?.length ?? 0) > 0;
      turn += 1;
      if (!toolsOffered) {
        return { id: "fin", model: "m", output: "synthesised final answer", toolCalls: [] };
      }
      const c: ModelToolCall = { id: `t${turn.toString()}`, name: "search", arguments: { n: turn } };
      return { id: `x${turn.toString()}`, model: "m", output: "still looking", toolCalls: [c] };
    },
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
      const out = opts.toolOutput(execCount);
      execCount += 1;
      opts.ran.push(execCount);
      return { result: { id: toolCall.id, name: toolCall.name, output: out, status: "completed" }, toolCall };
    }
  } as unknown as ModelLoopRunner;
}

describe("executeModelLoop — no-progress stall early-exit (arXiv:2505.17616)", () => {
  it("stops re-reading after the stall window and synthesises, instead of burning maxToolCalls", async () => {
    const ran: number[] = [];
    const result = await executeModelLoop(
      // Identical observation every read → near-identical → stall after window (3).
      stallRunner({ maxToolCalls: 10, ran, toolOutput: () => "results: alpha beta gamma delta" }),
      context(),
      provider,
      request()
    );
    // Executed only the 3 stalled reads, then withheld tools → clean synthesis.
    expect(ran.length).toBe(3);
    expect(result.finalResponse.output).toBe("synthesised final answer");
    expect(result.controlStopReason).toBe("no-progress");
  });

  it("non-vacuity / no false stall: PROGRESSING reads run to the maxToolCalls cap", async () => {
    const ran: number[] = [];
    const result = await executeModelLoop(
      // Each read distinct → never stalls → runs until the budget cap (10).
      stallRunner({ maxToolCalls: 10, ran, toolOutput: (n) => `results page ${n.toString()}: ${["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"][n] ?? "x"} unique terms` }),
      context(),
      provider,
      request()
    );
    expect(ran.length).toBe(10); // ran to the cap — the stall gate did NOT fire on progressing reads
    expect(result.finalResponse.output).toBe("synthesised final answer");
    expect(result.controlStopReason).toBeUndefined();
  });

  it.each([
    ["completed without verification", {
      output: "write returned without a receipt",
      status: "completed"
    }, 4],
    ["completed with an unverified receipt", {
      effectVerification: { reason: "read-back timed out", status: "unverified" },
      output: "write could not be verified",
      status: "completed"
    }, 4],
    ["blocked", {
      output: "write blocked",
      status: "blocked"
    }, 4],
    ["failed with a contradictory verified receipt", {
      effectVerification: { status: "verified" },
      output: "write failed",
      status: "failed"
    }, 4],
    ["completed with a verified receipt", {
      effectVerification: { status: "verified" },
      output: "write verified",
      status: "completed"
    }, 6]
  ] as const)("counts %s correctly at the production progress seam", async (
    _label,
    writeResult,
    expectedCalls
  ) => {
    const tools = [
      tool,
      { name: "update", description: "update", inputSchema: { type: "object" as const }, risk: "write" as const }
    ];
    let turn = 0;
    const calls: string[] = [];
    const runner = {
      maxToolCalls: 10,
      generateWithTracing: async (
        _ctx: AgentRunContext,
        _provider: ModelProvider,
        current: ModelRequest
      ): Promise<ModelResponse> => {
        if ((current.tools?.length ?? 0) === 0) {
          return { id: "fin", model: "m", output: "synthesised final answer", toolCalls: [] };
        }
        turn += 1;
        const name = turn === 3 ? "update" : "search";
        return {
          id: `response-${turn.toString()}`,
          model: "m",
          output: "still looking",
          toolCalls: [{ arguments: { turn }, id: `tool-${turn.toString()}`, name }]
        };
      },
      executeToolCall: async (
        _ctx: AgentRunContext,
        toolCall: ModelToolCall
      ): Promise<ExecutedToolResult> => {
        calls.push(toolCall.name);
        return toolCall.name === "update"
          ? {
              result: {
                id: toolCall.id,
                name: toolCall.name,
                ...writeResult
              } as ToolExecutionResult,
              toolCall
            }
          : {
              result: {
                id: toolCall.id,
                name: toolCall.name,
                output: "results: alpha beta gamma delta",
                status: "completed"
              },
              toolCall
            };
      }
    } as unknown as ModelLoopRunner;

    const result = await executeModelLoop(
      runner,
      context(),
      provider,
      { ...request(), tools }
    );

    expect(calls).toHaveLength(expectedCalls);
    expect(calls.slice(0, 4)).toEqual(["search", "search", "update", "search"]);
    expect(result.controlStopReason).toBe("no-progress");
  });
});
