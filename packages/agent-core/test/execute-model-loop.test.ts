import type { ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

const provider = {} as unknown as ModelProvider; // only handed to the faked generateWithTracing
const tool = { name: "echo", description: "echoes", inputSchema: { type: "object" as const } };

const context = (signal?: AbortSignal): AgentRunContext => ({
  runId: "run-1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "hi" }], ...(signal ? { signal } : {}) },
});
const request = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [tool] });
const call = (id: string, name: string): ModelToolCall => ({ id, name, arguments: {} });

// A runner whose model turns are scripted and whose tool execution just
// echoes a deterministic output, recording which tools it actually ran.
const runner = (opts: {
  turns: ModelResponse[];
  maxToolCalls?: number;
  ran?: string[];
}): ModelLoopRunner => {
  let turn = 0;
  return {
    maxToolCalls: opts.maxToolCalls ?? 5,
    generateWithTracing: async () => opts.turns[Math.min(turn++, opts.turns.length - 1)]!,
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
      opts.ran?.push(toolCall.name);
      return { result: { id: toolCall.id, name: toolCall.name, output: `ran ${toolCall.name}`, status: "ok" }, toolCall };
    },
  } as unknown as ModelLoopRunner;
};
const resp = (output: string, toolCalls: ModelToolCall[] = []): ModelResponse => ({ id: "x", model: "m", output, toolCalls });

describe("executeModelLoop", () => {
  it("returns the first response immediately when the model requests no tools", async () => {
    const result = await executeModelLoop(runner({ turns: [resp("done")] }), context(), provider, request());
    expect(result.finalResponse.output).toBe("done");
    expect(result.toolsUsed).toEqual([]);
    expect(result.toolResults).toHaveLength(0);
  });

  it("runs a requested tool, then returns the model's follow-up answer", async () => {
    const ran: string[] = [];
    const result = await executeModelLoop(
      runner({ ran, turns: [resp("calling", [call("t1", "echo")]), resp("final answer")] }),
      context(),
      provider,
      request(),
    );
    expect(result.finalResponse.output).toBe("final answer");
    expect(result.toolsUsed).toEqual(["echo"]);
    expect(ran).toEqual(["echo"]);
    // The assistant tool-call turn and the tool result both land in the transcript.
    expect(result.intermediateMessages.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(result.toolResults[0]?.result.output).toBe("ran echo");
  });

  it("disables tools entirely when maxToolCalls is 0 (returns the first turn untouched)", async () => {
    const ran: string[] = [];
    const result = await executeModelLoop(
      runner({ ran, maxToolCalls: 0, turns: [resp("forced", [call("t1", "echo")])] }),
      context(),
      provider,
      request(),
    );
    expect(result.finalResponse.output).toBe("forced");
    expect(result.toolResults).toHaveLength(0);
    expect(ran).toEqual([]);
  });

  it("blocks tool calls beyond maxToolCalls within a single batch", async () => {
    const result = await executeModelLoop(
      runner({ maxToolCalls: 1, turns: [resp("x", [call("a", "alpha"), call("b", "beta")]), resp("fin")] }),
      context(),
      provider,
      request(),
    );
    expect(result.toolResults.map((r) => r.result.status)).toEqual(["ok", "blocked"]);
    expect(result.toolResults[1]?.result.output).toContain("max tool call limit reached");
  });

  it("stops cleanly with an interrupted response when the run signal is already aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const result = await executeModelLoop(runner({ turns: [resp("never")] }), context(aborted.signal), provider, request());
    expect(result.finalResponse.id).toBe("interrupted");
    expect(result.finalResponse.output).toBe("(run interrupted)");
  });

  // Runaway guard (agent-eval / backlog P1): the wall-clock deadline cuts the
  // loop short — once exceeded, the next turn is offered NO tools (so the model
  // synthesizes a clean answer instead of asking for one we'd refuse), even if
  // every turn keeps requesting a tool. Honours CLAUDE.md's "explicit limits".
  it("stops calling tools once maxRunWallclockMs is exceeded (in-flight tool finishes, loop then cuts)", async () => {
    const toolsPerTurn: number[] = [];
    let turn = 0;
    const loop = {
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => {
        await new Promise((resolve) => setTimeout(resolve, 5)); // push past the 1ms deadline
        return { result: { id: toolCall.id, name: toolCall.name, output: "ran", status: "ok" }, toolCall };
      },
      generateWithTracing: async (_ctx: AgentRunContext, _provider: unknown, req: ModelRequest) => {
        toolsPerTurn.push((req.tools ?? []).length);
        turn += 1;
        return resp(`turn${turn}`, [call(`t${turn}`, "echo")]); // every turn WANTS a tool
      },
      maxRunWallclockMs: 1,
      maxToolCalls: 5,
    } as unknown as ModelLoopRunner;

    const result = await executeModelLoop(loop, context(), provider, request());
    // turn 1 ran with tools (deadline not yet passed); a later turn got none
    expect(toolsPerTurn[0]).toBeGreaterThan(0);
    expect(toolsPerTurn[toolsPerTurn.length - 1]).toBe(0);
    // only the in-flight tool ran — the wall-clock cut the loop before another
    expect(result.toolsUsed).toEqual(["echo"]);
    expect(result.toolResults).toHaveLength(1);
  });

  it("treats maxRunWallclockMs of 0 as NO wall-clock limit (not an immediately-exceeded deadline)", async () => {
    // The deadline guard is `maxRunWallclockMs > 0`; a 0 means "unbounded", so it
    // must NOT create a Date.now()+0 deadline that disables tools on turn 1. A
    // `> 0`→`>= 0` regression would silently kill every tool call.
    let turn = 0;
    const loop = {
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> =>
        ({ result: { id: toolCall.id, name: toolCall.name, output: "ran", status: "ok" }, toolCall }),
      generateWithTracing: async () => {
        turn += 1;
        return turn === 1 ? resp("calling", [call("t1", "echo")]) : resp("final answer");
      },
      maxRunWallclockMs: 0,
      maxToolCalls: 5,
    } as unknown as ModelLoopRunner;
    const result = await executeModelLoop(loop, context(), provider, request());
    expect(result.toolsUsed).toEqual(["echo"]); // the tool ran — 0 did not disable tools
    expect(result.finalResponse.output).toBe("final answer");
  });

  it("cuts the REST of a batch with a wall-clock reason when the deadline crosses MID-batch (injected clock — deterministic)", async () => {
    // Two calls in one turn; the first runs and advances the clock past the
    // deadline, so the second is blocked — and with the wall-clock reason, NOT the
    // max-tool-call one. An injected `now` makes the mid-batch cut testable without
    // a timing race. (maxToolCalls is high so the limiter is the deadline.)
    let clock = 0;
    const loop = {
      now: () => clock,
      maxRunWallclockMs: 100,
      maxToolCalls: 5,
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => {
        clock = 200; // first call's work pushes wall-clock past the 100ms deadline
        return { result: { id: toolCall.id, name: toolCall.name, output: "ran", status: "ok" }, toolCall };
      },
      generateWithTracing: async () => resp("x", [call("a", "alpha"), call("b", "beta")]),
    } as unknown as ModelLoopRunner;
    const result = await executeModelLoop(loop, context(), provider, request());
    expect(result.toolResults.map((r) => r.result.status)).toEqual(["ok", "blocked"]);
    expect(result.toolResults[1]?.result.output).toContain("wall-clock deadline reached");
    expect(result.toolResults[1]?.result.output).not.toContain("max tool call limit");
  });

  // Trajectory / step-efficiency (agent-eval gap C, DeepEval PlanAdherence +
  // StepEfficiency): assert the ORDERED spans of a multi-step run and that the
  // loop runs exactly the requested tools, once each, with no redundant calls.
  describe("trajectory & step-efficiency", () => {
    it("preserves the ordered model->tool->model->tool->synthesis trajectory across two tools", async () => {
      const ran: string[] = [];
      const result = await executeModelLoop(
        runner({ ran, turns: [resp("", [call("a", "alpha")]), resp("", [call("b", "beta")]), resp("final answer")] }),
        context(),
        provider,
        request(),
      );
      expect(result.toolsUsed).toEqual(["alpha", "beta"]);
      expect(result.intermediateMessages.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool"]);
      expect(result.toolResults.map((r) => r.result.status)).toEqual(["ok", "ok"]);
      expect(result.finalResponse.output).toBe("final answer");
    });

    it("runs exactly the requested tools (once each, in order) — no redundant or dropped calls", async () => {
      const ran: string[] = [];
      const result = await executeModelLoop(
        runner({ ran, turns: [resp("", [call("a", "alpha")]), resp("", [call("b", "beta")]), resp("done")] }),
        context(),
        provider,
        request(),
      );
      // step-efficiency: the executed-tool sequence equals the planned one
      expect(ran).toEqual(["alpha", "beta"]);
      expect(result.toolResults).toHaveLength(2);
    });

    it("takes the zero-tool trajectory when the model answers directly (most efficient path)", async () => {
      const ran: string[] = [];
      const result = await executeModelLoop(runner({ ran, turns: [resp("direct answer")] }), context(), provider, request());
      expect(ran).toEqual([]);
      expect(result.toolsUsed).toEqual([]);
      expect(result.intermediateMessages).toHaveLength(0);
    });
  });

  // Failure-injection: the loop composes invoke + tool-exec; these lock how an
  // UNEXPECTED throw from either propagates (the run wrapper turns it into a
  // failed run; here we assert the loop itself rejects and doesn't swallow it).
  describe("failure injection", () => {
    const throwingGenerate = (over: Partial<ModelLoopRunner>): ModelLoopRunner =>
      ({
        executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => ({
          result: { id: toolCall.id, name: toolCall.name, output: "ran", status: "ok" },
          toolCall,
        }),
        maxToolCalls: 5,
        ...over,
      }) as unknown as ModelLoopRunner;

    it("rejects when the first model turn throws (no retry/fallback at the loop layer)", async () => {
      const loop = throwingGenerate({ generateWithTracing: async () => { throw new Error("model down turn1"); } });
      await expect(executeModelLoop(loop, context(), provider, request())).rejects.toThrow("model down turn1");
    });

    it("rejects when a later model turn throws — after the requested tool already ran", async () => {
      let turn = 0;
      const ran: string[] = [];
      const loop = throwingGenerate({
        executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
          ran.push(toolCall.name);
          return { result: { id: toolCall.id, name: toolCall.name, output: "ran", status: "ok" }, toolCall };
        },
        generateWithTracing: async () => {
          if (turn++ === 0) return resp("calling", [call("t1", "echo")]);
          throw new Error("model down turn2");
        },
      });
      await expect(executeModelLoop(loop, context(), provider, request())).rejects.toThrow("model down turn2");
      expect(ran).toEqual(["echo"]);
    });

    it("propagates an unexpected throw from executeToolCall (not captured as a tool-error result)", async () => {
      let turn = 0;
      const loop = throwingGenerate({
        executeToolCall: async () => { throw new Error("tool exploded"); },
        generateWithTracing: async () => (turn++ === 0 ? resp("calling", [call("t1", "echo")]) : resp("final")),
      });
      await expect(executeModelLoop(loop, context(), provider, request())).rejects.toThrow("tool exploded");
    });
  });
});
