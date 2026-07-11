import type { ModelEvent, ModelProvider, ModelRequest, ModelResponse, ModelToolCall } from "@muse/model";
import { describe, expect, it } from "vitest";

import { executeStreamingModelLoop, type ModelLoopRunner } from "../src/model-loop.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

const noopSpan = { setAttribute() {}, setError() {}, end() {} };
const tool = { name: "echo", description: "echoes", inputSchema: { type: "object" as const } };

const context: AgentRunContext = {
  runId: "run-heartbeat-1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "hi" }] }
};
const request = (): ModelRequest => ({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [tool] });
const done = (output: string, toolCalls: ModelToolCall[] = []): ModelEvent => ({
  type: "done",
  response: { id: "d", model: "m", output, toolCalls } as ModelResponse
});

const provider = (turns: ModelEvent[][]): ModelProvider => {
  let turn = 0;
  return {
    id: "fake",
    stream: async function* () {
      for (const event of turns[Math.min(turn++, turns.length - 1)]!) yield event;
    }
  } as unknown as ModelProvider;
};

function runnerWith(heartbeat?: (runId: string) => void): ModelLoopRunner {
  return {
    maxToolCalls: 5,
    tracer: { startSpan: () => noopSpan },
    metrics: { recordTokenUsage() {} },
    ...(heartbeat ? { heartbeat } : {}),
    executeToolCall: async (_ctx: AgentRunContext, toolCall: ModelToolCall): Promise<ExecutedToolResult> => ({
      result: { id: toolCall.id, name: toolCall.name, output: `ran ${toolCall.name}`, status: "ok" },
      toolCall
    })
  } as unknown as ModelLoopRunner;
}

async function drive(prov: ModelProvider, run: ModelLoopRunner) {
  const gen = executeStreamingModelLoop(run, context, prov, request(), { forwardTextDeltas: true });
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}

describe("model-loop heartbeat emission (in-run liveness seam)", () => {
  it("pings runner.heartbeat with the run's runId on stream text-delta progress and on the tool-call event", async () => {
    const calls: string[] = [];
    const heartbeat = (runId: string) => { calls.push(runId); };
    const prov = provider([
      [{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }, done("calling", [{ id: "t1", name: "echo", arguments: {} }])],
      [{ type: "text-delta", text: "final" }, done("")]
    ]);
    const execution = await drive(prov, runnerWith(heartbeat));
    // 2 text-deltas (turn 1) + 1 genuine tool execution + 1 text-delta (turn 2) = 4.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.every((id) => id === "run-heartbeat-1")).toBe(true);
    expect(execution.toolsUsed).toEqual(["echo"]);
    expect(execution.finalResponse.output).toBe("final");
  });

  it("pings heartbeat exactly once per GENUINELY EXECUTED tool call, even with no streamed text", async () => {
    const calls: string[] = [];
    const heartbeat = (runId: string) => { calls.push(runId); };
    // Both tool calls surface via the turn's single "done" event (never the
    // direct streamed "tool-call" event), so every heartbeat call here comes
    // from runToolBatch's per-execution ping, isolating that emission point.
    const prov = provider([
      [done("calling", [{ id: "a", name: "alpha", arguments: {} }, { id: "b", name: "beta", arguments: {} }])],
      [done("final")]
    ]);
    const execution = await drive(prov, runnerWith(heartbeat));
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(["run-heartbeat-1", "run-heartbeat-1"]);
    expect(execution.toolsUsed).toEqual(["alpha", "beta"]);
  });

  it("with NO heartbeat injected, the run completes byte-identically (no crash, same output/tools)", async () => {
    const prov = provider([
      [{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }, done("calling", [{ id: "t1", name: "echo", arguments: {} }])],
      [{ type: "text-delta", text: "final" }, done("")]
    ]);
    const execution = await drive(prov, runnerWith(undefined));
    expect(execution.finalResponse.output).toBe("final");
    expect(execution.toolsUsed).toEqual(["echo"]);
  });

  it("a throwing heartbeat callback never breaks the loop (best-effort liveness only)", async () => {
    const heartbeat = () => { throw new Error("boom"); };
    const prov = provider([
      [{ type: "text-delta", text: "hi" }, done("calling", [{ id: "t1", name: "echo", arguments: {} }])],
      [done("final")]
    ]);
    const execution = await drive(prov, runnerWith(heartbeat));
    expect(execution.finalResponse.output).toBe("final");
    expect(execution.toolsUsed).toEqual(["echo"]);
  });
});
