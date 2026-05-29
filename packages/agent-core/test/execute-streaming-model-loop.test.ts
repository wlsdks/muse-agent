import { ModelProviderError, type ModelEvent, type ModelProvider, type ModelRequest, type ModelResponse, type ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeStreamingModelLoop, type ModelLoopRunner, type ModelLoopStreamEvent } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
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
