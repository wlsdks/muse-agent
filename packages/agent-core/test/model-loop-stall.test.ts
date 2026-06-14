import type { ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
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
  });
});
