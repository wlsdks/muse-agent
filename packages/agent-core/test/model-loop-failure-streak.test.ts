import type { ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

// Cascade-failure circuit breaker (arXiv:2509.25370). A tool that keeps FAILING
// is withheld after TOOL_FAILURE_STREAK_LIMIT (3) consecutive failures so it
// can't burn the whole maxToolCalls budget; a SUCCESS resets its streak.
//
// Crucially the failing tool returns a DIFFERENT error string each turn — so the
// no-progress stall detector (arXiv:2505.17616, output-similarity) does NOT fire
// and the failure-STATUS breaker is the only thing that can stop the loop. That
// isolates the new mechanism and is the revert anchor (neutralise `tripped` →
// these run to the maxToolCalls cap, because the stall gate can't catch them).

const provider = {} as unknown as ModelProvider;
const tool = { name: "flaky_read", description: "read", inputSchema: { type: "object" as const }, risk: "read" as const };

const context = (): AgentRunContext => ({
  runId: "run-fail-streak",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "fetch it" }] }
});
const request = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "fetch it" }], tools: [tool] });

// While tools are offered, the model keeps requesting `flaky_read` with a UNIQUE
// arg each turn (so the exact-signature deduplicator never collapses them — they
// genuinely execute). `status(callIndex)` decides each execution's status; every
// output is distinct (so the stall detector never fires). When the loop withholds
// tools (activeTools=[]), the model returns a final synthesis.
function flakyRunner(opts: {
  status: (n: number) => "completed" | "failed";
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
      const c: ModelToolCall = { id: `t${turn.toString()}`, name: "flaky_read", arguments: { n: turn } };
      return { id: `x${turn.toString()}`, model: "m", output: "still trying", toolCalls: [c] };
    },
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
      const n = execCount;
      execCount += 1;
      opts.ran.push(execCount);
      const status = opts.status(n);
      // Genuinely distinct tokens per turn so the no-progress stall detector
      // CANNOT fire — only the failure-STATUS breaker can stop this loop. The
      // varying number is embedded INSIDE each token (the stall tokeniser drops
      // length-<2 tokens, so a bare trailing digit would be dropped and the
      // outputs would look identical to it — the trap this fixture must avoid).
      const out = status === "failed"
        ? `econnreset${n.toString()} attemptfail${n.toString()}`
        : `okpayload${n.toString()} pageresult${n.toString()}`;
      return { result: { id: toolCall.id, name: toolCall.name, output: out, status }, toolCall };
    }
  } as unknown as ModelLoopRunner;
}

describe("executeModelLoop — tool-failure-streak circuit breaker (arXiv:2509.25370)", () => {
  it("withholds a tool that fails LIMIT times in a row (varying errors) and synthesises, instead of burning maxToolCalls", async () => {
    const ran: number[] = [];
    const result = await executeModelLoop(
      flakyRunner({ maxToolCalls: 10, ran, status: () => "failed" }),
      context(),
      provider,
      request()
    );
    // Tripped after exactly 3 consecutive failures → tool withheld → clean synthesis,
    // NOT the full 10-call budget. (Distinct error text each turn, so the stall
    // detector did not fire — the failure-streak breaker is what stopped it.)
    expect(ran.length).toBe(3);
    expect(result.finalResponse.output).toBe("synthesised final answer");
  });

  it("a SUCCESS resets the streak: fail,fail,succeed,… never trips and runs to the cap", async () => {
    const ran: number[] = [];
    const result = await executeModelLoop(
      // Pattern fail,fail,succeed repeating → never 3 consecutive failures.
      // WITHOUT the success-reset the streak would count past 3 and trip ~turn 4;
      // WITH it the breaker never fires → runs to the maxToolCalls cap (10).
      flakyRunner({ maxToolCalls: 10, ran, status: (n) => (n % 3 === 2 ? "completed" : "failed") }),
      context(),
      provider,
      request()
    );
    expect(ran.length).toBe(10);
    expect(result.finalResponse.output).toBe("synthesised final answer");
  });
});
