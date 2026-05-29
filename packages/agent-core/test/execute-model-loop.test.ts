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
