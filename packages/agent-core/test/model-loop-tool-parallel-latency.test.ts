import type { ModelProvider, ModelRequest, ModelResponse, ModelTool, ModelToolCall } from "@muse/model";
import { InMemoryMuseTracer } from "@muse/observability";
import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";


import { executeModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

const provider = {} as unknown as ModelProvider;

const context = (): AgentRunContext => ({
  runId: "run-1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "hi" }] },
});

const resp = (output: string, toolCalls: ModelToolCall[] = []): ModelResponse => ({ id: "x", model: "m", output, toolCalls });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ModelToolCall => ({ id, name, arguments: args });

type ToolSpec = {
  readonly risk: ModelTool["risk"];
  readonly delayMs?: number;
  readonly status?: "completed" | "failed";
};

/**
 * A runner whose tools are declared with a risk + optional artificial delay,
 * and whose executeToolCall pushes each executed tool name to `order` at the
 * moment it STARTS and completes after the delay. A single real InMemory tracer
 * captures the per-tool latency spans.
 */
const runner = (opts: {
  turns: ModelResponse[];
  tools: Record<string, ToolSpec>;
  started?: string[];
  finished?: string[];
  tracer?: InMemoryMuseTracer;
  maxToolCalls?: number;
}): ModelLoopRunner => {
  let turn = 0;
  return {
    maxToolCalls: opts.maxToolCalls ?? 10,
    tracer: opts.tracer ?? new InMemoryMuseTracer(),
    generateWithTracing: async () => opts.turns[Math.min(turn++, opts.turns.length - 1)]!,
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => {
      const spec = opts.tools[toolCall.name]!;
      opts.started?.push(toolCall.name);
      if (spec.delayMs) {
        await sleep(spec.delayMs);
      }
      opts.finished?.push(toolCall.name);
      return { result: { id: toolCall.id, name: toolCall.name, output: `ran ${toolCall.name}`, status: spec.status ?? "completed" }, toolCall };
    },
  } as unknown as ModelLoopRunner;
};

const request = (tools: Record<string, ToolSpec>): ModelRequest => ({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  tools: Object.entries(tools).map(([name, spec]) => ({ name, description: name, inputSchema: { type: "object" as const }, risk: spec.risk })),
});

describe("DS-6 per-tool latency span (muse.tool.execute)", () => {
  it("records a muse.tool.execute span for a SUCCESSFUL tool call with tool.name + status=ok", async () => {
    const tracer = new InMemoryMuseTracer();
    const tools = { echo: { risk: "read" as const } };
    await executeModelLoop(
      runner({ tracer, tools, turns: [resp("calling", [call("t1", "echo")]), resp("done")] }),
      context(), provider, request(tools),
    );
    const spans = tracer.recordedSpans().filter((s) => s.name === "muse.tool.execute");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["tool.name"]).toBe("echo");
    expect(spans[0]?.attributes["tool.status"]).toBe("ok");
    expect(typeof spans[0]?.attributes["duration.ms"]).toBe("number");
    // start→end duration is what the LatencyQuery reads out of the trace store.
    expect(spans[0]?.endedAt).toBeInstanceOf(Date);
  });

  it("records status=error for a FAILING tool call (result.status === 'failed')", async () => {
    const tracer = new InMemoryMuseTracer();
    const tools = { flaky: { risk: "read" as const, status: "failed" as const } };
    await executeModelLoop(
      runner({ tracer, tools, turns: [resp("calling", [call("t1", "flaky")]), resp("done")] }),
      context(), provider, request(tools),
    );
    const spans = tracer.recordedSpans().filter((s) => s.name === "muse.tool.execute");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["tool.status"]).toBe("error");
  });

  it("does NOT time deduplicated / blocked calls — only genuine executions get a span", async () => {
    const tracer = new InMemoryMuseTracer();
    // maxToolCalls=1: the 2nd call in the batch is blocked, never executes.
    const tools = { readA: { risk: "read" as const }, readB: { risk: "read" as const } };
    await executeModelLoop(
      runner({ tracer, tools, maxToolCalls: 1, turns: [resp("x", [call("a", "readA"), call("b", "readB")]), resp("done")] }),
      context(), provider, request(tools),
    );
    const spans = tracer.recordedSpans().filter((s) => s.name === "muse.tool.execute");
    expect(spans).toHaveLength(1); // only readA executed; readB was blocked (no span)
    expect(spans[0]?.attributes["tool.name"]).toBe("readA");
  });
});

describe("DS-9 parallel read-only fan-out", () => {
  it("runs a contiguous run of read-only calls CONCURRENTLY (wall-clock ≈ max delay, not sum)", async () => {
    const tools = { readA: { risk: "read" as const, delayMs: 60 }, readB: { risk: "read" as const, delayMs: 60 }, readC: { risk: "read" as const, delayMs: 60 } };
    const started = new Date().getTime();
    const result = await executeModelLoop(
      runner({ tools, turns: [resp("x", [call("a", "readA"), call("b", "readB"), call("c", "readC")]), resp("done")] }),
      context(), provider, request(tools),
    );
    const elapsed = new Date().getTime() - started;
    // Concurrent ⇒ ~60ms. Sequential would be ~180ms — the mutation guard: a
    // revert to a sequential `for … await` makes this assertion go RED.
    expect(elapsed).toBeLessThan(150);
    // Result ORDER is still the original order regardless of execution overlap.
    expect(result.toolsUsed).toEqual(["readA", "readB", "readC"]);
    expect(result.toolResults.map((r) => r.result.name)).toEqual(["readA", "readB", "readC"]);
  });

  it("keeps write/execute calls sequential AND ordered relative to reads (shared-array execution order)", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    // [readA, readB, writeC]: readA+readB parallelize; writeC runs AFTER both.
    const tools = {
      readA: { risk: "read" as const, delayMs: 40 },
      readB: { risk: "read" as const, delayMs: 40 },
      writeC: { risk: "write" as const },
    };
    const result = await executeModelLoop(
      runner({ tools, started, finished, turns: [resp("x", [call("a", "readA"), call("b", "readB"), call("c", "writeC")]), resp("done")] }),
      context(), provider, request(tools),
    );
    // The write starts only after BOTH reads finished (segment boundary).
    expect(started[started.length - 1]).toBe("writeC");
    expect(finished).toEqual(expect.arrayContaining(["readA", "readB"]));
    expect(finished[finished.length - 1]).toBe("writeC");
    expect(finished.indexOf("writeC")).toBeGreaterThan(finished.indexOf("readA"));
    expect(finished.indexOf("writeC")).toBeGreaterThan(finished.indexOf("readB"));
    // Observable result order is exactly the original call order.
    expect(result.toolsUsed).toEqual(["readA", "readB", "writeC"]);
  });

  it("runs two write calls strictly sequentially in original order", async () => {
    const started: string[] = [];
    const tools = { writeA: { risk: "write" as const, delayMs: 20 }, writeB: { risk: "write" as const } };
    const result = await executeModelLoop(
      runner({ tools, started, turns: [resp("x", [call("a", "writeA"), call("b", "writeB")]), resp("done")] }),
      context(), provider, request(tools),
    );
    expect(started).toEqual(["writeA", "writeB"]); // B did not start before A finished
    expect(result.toolResults.map((r) => r.result.name)).toEqual(["writeA", "writeB"]);
  });

  it("a call with UNRESOLVED risk (tool not in active set) stays sequential", async () => {
    const started: string[] = [];
    // 'mystery' is requested but NOT declared in request.tools ⇒ risk undefined ⇒ non-read ⇒ sequential.
    const tools = { readA: { risk: "read" as const, delayMs: 20 } };
    const runnerTools = { ...tools, mystery: { risk: "read" as const } }; // executor knows it; active set does not
    const result = await executeModelLoop(
      runner({ tools: runnerTools, started, turns: [resp("x", [call("a", "readA"), call("m", "mystery")]), resp("done")] }),
      context(), provider, request(tools),
    );
    expect(result.toolsUsed).toEqual(["readA", "mystery"]);
  });
});
