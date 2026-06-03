import type { ModelProvider, ModelRequest, ModelResponse, ModelTool, ModelToolCall } from "@muse/model";
import type { ToolExecutionResult } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { streamPlanExecute, type PlanExecuteRunner, type PlanExecuteStreamEvent } from "../src/plan-execute-loop.js";
import type { AgentRunContext } from "../src/types.js";

// Adaptive RE-DECOMPOSITION (P43-2 carry-to-done): when a READ step's effect
// fails even after the bounded retry, the loop generates an alternative READ-ONLY
// sub-plan and runs it. A scripted runner gives precise control of the plan /
// re-plan model responses + each tool result (no live model). The SAFETY contract
// proven here: only a read-step failure triggers a re-plan, and any write the
// re-plan proposes is dropped — recovery can never act on the world (no double-act).

const readTool = (name: string): ModelTool => ({ description: `read ${name}`, inputSchema: { properties: {}, type: "object" }, name, risk: "read" });
const writeTool = (name: string): ModelTool => ({ description: `write ${name}`, inputSchema: { properties: {}, type: "object" }, name, risk: "write" });

const context = (): AgentRunContext => ({
  input: { messages: [{ content: "find the venue capacity then summarise", role: "user" }], metadata: {}, model: "test" },
  runId: "run-replan",
  startedAt: new Date("2026-01-01T00:00:00Z")
});
const provider = (): ModelProvider => ({}) as unknown as ModelProvider;
const request = (tools: readonly ModelTool[]): ModelRequest => ({
  messages: [{ content: "You are Muse.", role: "system" }, { content: "find the venue capacity then summarise", role: "user" }],
  model: "test",
  tools
}) as ModelRequest;

const completed = (name: string, output: string): ToolExecutionResult => ({ id: name, name, output, status: "completed" });

const scriptedRunner = (opts: {
  plans: readonly string[];
  toolResult: (name: string) => ToolExecutionResult;
  ran: string[];
  counters: { planCalls: number };
}): PlanExecuteRunner => {
  let planIdx = 0;
  return {
    executeToolCall: async (_ctx, toolCall: ModelToolCall) => {
      opts.ran.push(toolCall.name);
      return { result: opts.toolResult(toolCall.name), toolCall };
    },
    generateWithTracing: async (_ctx, _prov, req: ModelRequest): Promise<ModelResponse> => {
      // Plan / re-plan requests carry a responseFormat; synthesis does not.
      if (req.responseFormat !== undefined) {
        opts.counters.planCalls += 1;
        const out = opts.plans[Math.min(planIdx, opts.plans.length - 1)] ?? "[]";
        planIdx += 1;
        return { id: "p", model: "m", output: out, toolCalls: [] };
      }
      return { id: "s", model: "m", output: "Final synthesised answer.", toolCalls: [] };
    },
    maxToolCalls: 8
  } as unknown as PlanExecuteRunner;
};

const drain = async (gen: AsyncGenerator<PlanExecuteStreamEvent, unknown>): Promise<{ events: PlanExecuteStreamEvent[]; value: unknown }> => {
  const events: PlanExecuteStreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) { events.push(next.value); next = await gen.next(); }
  return { events, value: next.value };
};

describe("plan-execute adaptive re-decomposition (P43-2) — read-only recovery + the no-double-act guards", () => {
  const plan = (steps: readonly { tool: string; description: string }[]): string =>
    JSON.stringify(steps.map((s) => ({ args: {}, description: s.description, tool: s.tool })));

  it("RECOVERS a failed READ step by re-decomposing to an alternative read tool (carry-to-done)", async () => {
    const ran: string[] = [];
    const counters = { planCalls: 0 };
    const runner = scriptedRunner({
      counters, ran,
      plans: [
        plan([{ description: "look up the capacity", tool: "lookup_a" }]),
        plan([{ description: "alternative lookup", tool: "lookup_b" }])
      ],
      toolResult: (name) => name === "lookup_b" ? completed(name, "Capacity is 120.") : completed(name, "Error: upstream 503")
    });
    const { events } = await drain(streamPlanExecute(runner, context(), provider(), request([readTool("lookup_a"), readTool("lookup_b")])));

    const results = events.filter((e) => e.type === "plan-step-result") as Extract<PlanExecuteStreamEvent, { type: "plan-step-result" }>[];
    expect(results.map((e) => e.success)).toEqual([true]); // the failed read RECOVERED via the alternative
    expect(ran).toEqual(["lookup_a", "lookup_a", "lookup_b"]); // bounded retry (×2) then the read alternative
    expect(counters.planCalls).toBe(2); // original plan + exactly ONE re-plan
    expect(events.at(-1)?.type).toBe("synthesis-started"); // carried to a verified done
  });

  it("NEVER re-plans a failed WRITE step (no double-act) — fails closed instead", async () => {
    const ran: string[] = [];
    const counters = { planCalls: 0 };
    const runner = scriptedRunner({
      counters, ran,
      plans: [plan([{ description: "send the message", tool: "send_x" }])],
      toolResult: () => completed("send_x", "Error: send failed")
    });
    await expect(drain(streamPlanExecute(runner, context(), provider(), request([writeTool("send_x")]))))
      .rejects.toThrow(/Every plan step failed/u);
    expect(ran).toEqual(["send_x"]); // exactly once — a write is not retried AND not re-planned
    expect(counters.planCalls).toBe(1); // only the original plan; a write failure NEVER triggers a re-plan
  });

  it("DROPS a write step a re-plan proposes (recovery is read-only) — the write tool is never called", async () => {
    const ran: string[] = [];
    const counters = { planCalls: 0 };
    const runner = scriptedRunner({
      counters, ran,
      plans: [
        plan([{ description: "look up the data", tool: "lookup_a" }]),
        plan([{ description: "create the missing data", tool: "create_x" }]) // a WRITE the re-plan must drop
      ],
      toolResult: (name) => name === "create_x" ? completed(name, "Created.") : completed(name, "Error: 503")
    });
    await expect(drain(streamPlanExecute(runner, context(), provider(), request([readTool("lookup_a"), writeTool("create_x")]))))
      .rejects.toThrow(/Every plan step failed/u);
    expect(ran).toEqual(["lookup_a", "lookup_a"]); // the read failed (retried); the proposed WRITE was dropped
    expect(ran).not.toContain("create_x"); // SAFETY: a re-plan write is never executed
    expect(counters.planCalls).toBe(2); // a re-plan WAS attempted (the read failed) — but its write step was filtered out
  });
});
