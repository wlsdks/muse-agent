import { ModelProviderError, type ModelEvent, type ModelProvider, type ModelRequest, type ModelResponse, type ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeStreamingModelLoop, type ModelLoopRunner, type ModelLoopStreamEvent } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import { TOOL_FAILURE_STREAK_LIMIT } from "../src/tool-failure-streak.js";
import type { AgentRunContext } from "../src/types.js";

const noopSpan = { setAttribute() {}, setError() {}, end() {} };
const tool = { name: "echo", description: "echoes", inputSchema: { type: "object" as const } };

const context = (signal?: AbortSignal): AgentRunContext => ({
  runId: "run-1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "hi" }], ...(signal ? { signal } : {}) },
});
const request = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [tool] });
const done = (output: string, toolCalls: ModelToolCall[] = []): ModelEvent => ({
  type: "done",
  response: { id: "d", model: "m", output, toolCalls } as ModelResponse,
});

// A provider whose stream replays a scripted list of events per turn.
const provider = (turns: ModelEvent[][]): ModelProvider => {
  let turn = 0;
  return {
    id: "fake",
    stream: async function* () {
      for (const event of turns[Math.min(turn++, turns.length - 1)]!) yield event;
    },
  } as unknown as ModelProvider;
};
const runner = (opts: { maxToolCalls?: number; ran?: string[] } = {}): ModelLoopRunner =>
  ({
    maxToolCalls: opts.maxToolCalls ?? 5,
    tracer: { startSpan: () => noopSpan },
    metrics: { recordTokenUsage() {} },
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
      opts.ran?.push(toolCall.name);
      return { result: { id: toolCall.id, name: toolCall.name, output: `ran ${toolCall.name}`, status: "ok" }, toolCall };
    },
  }) as unknown as ModelLoopRunner;

// Drain the stream generator, collecting yielded event types and the final return value.
async function drive(prov: ModelProvider, run: ModelLoopRunner, ctx: AgentRunContext, forwardTextDeltas: boolean) {
  const gen = executeStreamingModelLoop(run, ctx, prov, request(), { forwardTextDeltas });
  const events: ModelLoopStreamEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, execution: step.value };
}

describe("executeStreamingModelLoop", () => {
  it("forwards text-delta events and accumulates the streamed output", async () => {
    const prov = provider([[{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }, done("")]]);
    const { events, execution } = await drive(prov, runner(), context(), true);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta"]);
    expect(execution.finalResponse.output).toBe("Hello");
  });

  it("suppresses text-delta events when forwarding is off but still builds the output", async () => {
    const prov = provider([[{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }, done("")]]);
    const { events, execution } = await drive(prov, runner(), context(), false);
    expect(events).toEqual([]);
    expect(execution.finalResponse.output).toBe("Hello");
  });

  it("emits tool-call then tool-result, runs the tool, and returns the follow-up answer", async () => {
    const ran: string[] = [];
    const prov = provider([
      [done("calling", [{ id: "t1", name: "echo", arguments: {} }])],
      [{ type: "text-delta", text: "final" }, done("")],
    ]);
    const { events, execution } = await drive(prov, runner({ ran }), context(), true);
    expect(events.map((e) => e.type)).toEqual(["tool-call", "tool-result", "text-delta"]);
    expect(ran).toEqual(["echo"]);
    expect(execution.toolsUsed).toEqual(["echo"]);
    expect(execution.finalResponse.output).toBe("final");
  });

  it("attaches grounding to the tool-result event for a completed non-empty tool (the streaming surface's evidence)", async () => {
    const run = {
      maxToolCalls: 5,
      tracer: { startSpan: () => noopSpan },
      metrics: { recordTokenUsage() {} },
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => ({
        result: { id: toolCall.id, name: toolCall.name, output: "rent is 1,250,000 KRW", status: "completed" }, toolCall,
      }),
    } as unknown as ModelLoopRunner;
    const prov = provider([
      [done("calling", [{ id: "t1", name: "knowledge_search", arguments: {} }])],
      [{ type: "text-delta", text: "final" }, done("")],
    ]);
    const { events } = await drive(prov, run, context(), true);
    const toolResult = events.find((e) => e.type === "tool-result");
    expect((toolResult as { grounding?: unknown }).grounding).toEqual({ source: "knowledge_search", text: "rent is 1,250,000 KRW" });
  });

  it("omits grounding for a failed tool-result (an error string is not evidence — floor integrity on the stream)", async () => {
    const run = {
      maxToolCalls: 5,
      tracer: { startSpan: () => noopSpan },
      metrics: { recordTokenUsage() {} },
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => ({
        result: { id: toolCall.id, name: toolCall.name, output: "Error: boom", status: "failed" }, toolCall,
      }),
    } as unknown as ModelLoopRunner;
    const prov = provider([
      [done("calling", [{ id: "t1", name: "web_read", arguments: {} }])],
      [{ type: "text-delta", text: "final" }, done("")],
    ]);
    const { events } = await drive(prov, run, context(), true);
    const toolResult = events.find((e) => e.type === "tool-result");
    expect((toolResult as { grounding?: unknown }).grounding).toBeUndefined();
  });

  it("cuts the REST of a batch with the wall-clock reason when the deadline crosses MID-batch (injected clock)", async () => {
    // The streaming loop has the same mid-batch wall-clock guard as the
    // non-streaming one but no deadline test at all. Inject a clock: two calls in
    // one turn, the first advances past the 100ms deadline, the second is blocked
    // with the wall-clock reason — not the max-tool-call one.
    let clock = 0;
    const run = {
      maxToolCalls: 5,
      maxRunWallclockMs: 100,
      now: () => clock,
      tracer: { startSpan: () => noopSpan },
      metrics: { recordTokenUsage() {} },
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => {
        clock = 200;
        return { result: { id: toolCall.id, name: toolCall.name, output: "ran", status: "ok" }, toolCall };
      },
    } as unknown as ModelLoopRunner;
    const prov = provider([
      [done("x", [{ id: "a", name: "alpha", arguments: {} }, { id: "b", name: "beta", arguments: {} }])],
      [done("final")],
    ]);
    const { execution } = await drive(prov, run, context(), true);
    expect(execution.toolResults.map((r) => r.result.status)).toEqual(["ok", "blocked"]);
    expect(execution.toolResults[1]?.result.output).toContain("wall-clock deadline reached");
    expect(execution.toolResults[1]?.result.output).not.toContain("max tool call limit");
  });

  it("returns the first turn with no tool execution when maxToolCalls is 0", async () => {
    const ran: string[] = [];
    const prov = provider([[done("forced", [{ id: "t1", name: "echo", arguments: {} }])]]);
    const { execution } = await drive(prov, runner({ ran, maxToolCalls: 0 }), context(), true);
    expect(execution.finalResponse.output).toBe("forced");
    expect(execution.toolResults).toHaveLength(0);
    expect(ran).toEqual([]);
  });

  it("returns an interrupted execution when the run signal is already aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const prov = provider([[done("never")]]);
    const { events, execution } = await drive(prov, runner(), context(aborted.signal), true);
    expect(events).toEqual([]);
    expect(execution.finalResponse.id).toBe("interrupted");
    expect(execution.finalResponse.output).toBe("(run interrupted)");
  });

  it("propagates a provider error event out of the loop", async () => {
    const prov = provider([[{ type: "error", error: new ModelProviderError("fake", "boom", true) }]]);
    await expect(drive(prov, runner(), context(), true)).rejects.toThrow("boom");
  });

  // Failure-injection (backlog P1 streaming residual): a mid-stream {error} must
  // be SURFACED as an error event to the consumer (not a silent truncation) AND
  // recorded on the span, THEN throw. Strengthens the throw-only test above with
  // the end-to-end "what does the caller actually receive" contract.
  describe("mid-stream error surfacing", () => {
    // Collects every yielded event UP TO the throw, then returns them + the error.
    const driveUntilThrow = async (prov: ModelProvider, run: ModelLoopRunner) => {
      const gen = executeStreamingModelLoop(run, context(), prov, request(), { forwardTextDeltas: true });
      const events: ModelLoopStreamEvent[] = [];
      let thrown: unknown;
      try {
        let step = await gen.next();
        while (!step.done) { events.push(step.value); step = await gen.next(); }
      } catch (error) { thrown = error; }
      return { events, thrown };
    };
    const capturingRunner = (captured: unknown[]): ModelLoopRunner =>
      ({
        maxToolCalls: 5,
        tracer: { startSpan: () => ({ setAttribute() {}, setError(e: unknown) { captured.push(e); }, end() {} }) },
        metrics: { recordTokenUsage() {} },
        executeToolCall: async () => { throw new Error("should not run"); },
      }) as unknown as ModelLoopRunner;

    it("yields the partial text-deltas THEN an error event before throwing (no silent truncation)", async () => {
      const boom = new ModelProviderError("fake", "stream blew up", true);
      const prov = provider([[
        { type: "text-delta", text: "partial " },
        { type: "text-delta", text: "answer" },
        { type: "error", error: boom },
        done("should not reach"), // the loop must throw before consuming this
      ]]);
      const { events, thrown } = await driveUntilThrow(prov, capturingRunner([]));

      expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "error"]);
      expect(thrown).toBe(boom); // same instance, not a wrapped/new error
      expect(events.some((e) => e.type === "done")).toBe(false); // never reached a (false) success
    });

    it("the surfaced error event carries the SAME error that is thrown", async () => {
      const boom = new ModelProviderError("fake", "boom", true);
      const prov = provider([[{ type: "error", error: boom }]]);
      const { events, thrown } = await driveUntilThrow(prov, capturingRunner([]));
      const errorEvent = events.find((e) => e.type === "error") as Extract<ModelLoopStreamEvent, { type: "error" }>;
      expect(errorEvent.error).toBe(boom);
      expect(thrown).toBe(boom);
    });

    it("records the error on the tracing span (setError), not swallowed", async () => {
      const boom = new ModelProviderError("fake", "recorded", true);
      const captured: unknown[] = [];
      const prov = provider([[{ type: "error", error: boom }]]);
      await driveUntilThrow(prov, capturingRunner(captured));
      expect(captured).toContain(boom);
    });
  });
});

describe("executeStreamingModelLoop — tool-failure-streak circuit breaker (streaming-path coverage, fire 42 caveat)", () => {
  const flakyTool = { name: "flaky_read", description: "read", inputSchema: { type: "object" as const }, risk: "read" as const };
  const flakyRequest = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "fetch" }], tools: [flakyTool] });

  // Runner whose tool ALWAYS fails, with DISTINCT error text per call so the
  // no-progress stall detector (output-similarity) can't fire — only the failure
  // -STREAK breaker can stop the loop. (Mirrors the non-streaming fire-42 test;
  // closes the previously-untested streaming seam.)
  function flakyRunner(ran: string[], maxToolCalls = 10): ModelLoopRunner {
    return {
      maxToolCalls,
      tracer: { startSpan: () => noopSpan },
      metrics: { recordTokenUsage() {} },
      executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => {
        const n = ran.length;
        ran.push(toolCall.name);
        return { result: { id: toolCall.id, name: toolCall.name, output: `econnreset${n.toString()} attemptfail${n.toString()}`, status: "failed" }, toolCall };
      }
    } as unknown as ModelLoopRunner;
  }

  async function driveFlaky(prov: ModelProvider, run: ModelLoopRunner) {
    const gen = executeStreamingModelLoop(run, context(), prov, flakyRequest(), { forwardTextDeltas: false });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    return step.value;
  }

  it("withholds a tool that fails LIMIT times in a row (varying errors) → executes only LIMIT times, not the full budget", async () => {
    const ran: string[] = [];
    // The model requests flaky_read with UNIQUE args EVERY turn (so the exact-arg
    // deduplicator never collapses them — each genuinely executes and fails). With
    // the breaker the tool is withheld after the streak (3 executions); WITHOUT it
    // (revert-proof) the loop would run to maxToolCalls (10). Scripting more turns
    // than the limit is what makes this NON-vacuous — the count is decided by the
    // breaker, not by the script length.
    const flaky = (n: number): ModelEvent => done("trying", [{ id: `t${n.toString()}`, name: "flaky_read", arguments: { n } }]);
    const prov = provider(Array.from({ length: 12 }, (_, i) => [flaky(i + 1)]));
    await driveFlaky(prov, flakyRunner(ran));
    expect(ran).toHaveLength(TOOL_FAILURE_STREAK_LIMIT); // exactly 3 — withheld after the streak, not the 10-call budget
  });
});
