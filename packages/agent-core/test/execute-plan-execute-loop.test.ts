import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { describe, expect, it, vi } from "vitest";

import { executePlanExecuteLoop, type PlanExecuteRunner } from "../src/plan-execute-loop.js";
import { PlanExecutionError, PlanValidationFailedError, type PlanStep } from "../src/plan-execute.js";
import type { ExecutedToolResult } from "../src/runtime-internals.js";
import type { AgentRunContext } from "../src/types.js";

const provider = { id: "fake" } as unknown as ModelProvider;
const tools = [{ name: "get_weather", description: "weather", inputSchema: { type: "object" as const } }];

const context = (): AgentRunContext => ({
  runId: "run-1",
  startedAt: new Date("2026-01-01T00:00:00Z"),
  input: { model: "m", messages: [{ role: "user", content: "weather?" }], metadata: {} },
});
const request = (): ModelRequest => ({
  model: "m",
  messages: [{ role: "system", content: "sys" }, { role: "user", content: "weather?" }],
  tools,
});
const resp = (output: string): ModelResponse => ({ id: "x", model: "m", output });
const plan = (steps: PlanStep[]) => JSON.stringify(steps);
const step = (description = "do it"): PlanStep => ({ tool: "get_weather", args: {}, description });

// generateWithTracing is scripted by call order (1st = plan, 2nd = synthesis/direct).
const runner = (turns: ModelResponse[], opts: { maxToolCalls?: number; status?: string } = {}): PlanExecuteRunner => {
  let turn = 0;
  return {
    maxToolCalls: opts.maxToolCalls ?? 5,
    generateWithTracing: async () => turns[Math.min(turn++, turns.length - 1)]!,
    executeToolCall: async (_ctx, toolCall): Promise<ExecutedToolResult> => ({
      result: { id: toolCall.id, name: toolCall.name, output: "sunny", status: opts.status ?? "completed" },
      toolCall,
    }),
  };
};

describe("executePlanExecuteLoop", () => {
  it("runs a valid plan's steps and returns the synthesised answer", async () => {
    const result = await executePlanExecuteLoop(
      runner([resp(plan([step()])), resp("It is sunny.")]),
      context(),
      provider,
      request(),
    );
    expect(result.finalResponse.output).toBe("It is sunny.");
    expect(result.toolsUsed).toEqual(["get_weather"]);
    expect(result.toolResults).toHaveLength(1);
  });

  it("falls back to a direct answer when the plan is empty", async () => {
    const result = await executePlanExecuteLoop(
      runner([resp("[]"), resp("Direct answer.")]),
      context(),
      provider,
      request(),
    );
    expect(result.finalResponse.output).toBe("Direct answer.");
    expect(result.toolResults).toHaveLength(0);
  });

  it("throws PLAN_GENERATION_FAILED when the plan output cannot be parsed", async () => {
    await expect(
      executePlanExecuteLoop(runner([resp("there is no json plan here")]), context(), provider, request()),
    ).rejects.toMatchObject({ code: "PLAN_GENERATION_FAILED" });
  });

  it("throws PlanValidationFailedError when a step names an unavailable tool", async () => {
    const badPlan = JSON.stringify([{ tool: "launch_missiles", args: {}, description: "no" }]);
    await expect(
      executePlanExecuteLoop(runner([resp(badPlan)]), context(), provider, request()),
    ).rejects.toBeInstanceOf(PlanValidationFailedError);
  });

  it("throws PLAN_ALL_STEPS_FAILED when every step fails (refusing to synthesise)", async () => {
    await expect(
      executePlanExecuteLoop(runner([resp(plan([step()])), resp("syn")], { status: "failed" }), context(), provider, request()),
    ).rejects.toMatchObject({ code: "PLAN_ALL_STEPS_FAILED" });
  });

  it("blocks steps past maxToolCalls but still synthesises when an earlier step succeeded", async () => {
    // Use distinct args so the two steps are not treated as exact duplicates.
    const s1: PlanStep = { tool: "get_weather", args: { q: "first" }, description: "first" };
    const s2: PlanStep = { tool: "get_weather", args: { q: "second" }, description: "second" };
    const result = await executePlanExecuteLoop(
      runner([resp(plan([s1, s2])), resp("synthesised")], { maxToolCalls: 1 }),
      context(),
      provider,
      request(),
    );
    expect(result.finalResponse.output).toBe("synthesised");
    expect(result.toolResults.map((r) => r.result.status)).toEqual(["completed", "blocked"]);
  });

  it("throws RESPONSE_SYNTHESIS_FAILED when synthesis returns empty output", async () => {
    await expect(
      executePlanExecuteLoop(runner([resp(plan([step()])), resp("   ")]), context(), provider, request()),
    ).rejects.toMatchObject({ code: "RESPONSE_SYNTHESIS_FAILED" });
  });

  it("throws RESPONSE_SYNTHESIS_FAILED when the empty-plan direct answer is blank", async () => {
    const error = await executePlanExecuteLoop(runner([resp("[]"), resp("")]), context(), provider, request()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PlanExecutionError);
    expect((error as PlanExecutionError & { code: string }).code).toBe("RESPONSE_SYNTHESIS_FAILED");
  });

  it("throws RESPONSE_SYNTHESIS_FAILED when the empty-plan direct answer is WHITESPACE-only", async () => {
    // The blank case above covers the empty-string branch; a whitespace-only
    // answer ("   ") must also fail (the trim().length === 0 branch) — a model
    // returning only spaces hasn't actually answered.
    await expect(
      executePlanExecuteLoop(runner([resp("[]"), resp("   ")]), context(), provider, request()),
    ).rejects.toMatchObject({ code: "RESPONSE_SYNTHESIS_FAILED" });
  });
});

describe("executePlanExecuteLoop — near-duplicate dedup (no-double-act, Mem0 arXiv:2504.19413)", () => {
  const writeTools = [
    { name: "send_message", description: "send a message", risk: "write" as const, inputSchema: { type: "object" as const } },
  ];
  const writeRequest = (): ModelRequest => ({
    model: "m",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "send it" }],
    tools: writeTools,
  });

  const runnerWithSpy = (planJson: string, synth: string) => {
    const executeSpy = vi.fn(async (_ctx: AgentRunContext, toolCall: { id: string; name: string; arguments: Record<string, unknown> }): Promise<ExecutedToolResult> => ({
      result: { id: toolCall.id, name: toolCall.name, output: "sent", status: "completed" },
      toolCall,
    }));
    let turn = 0;
    const r: PlanExecuteRunner = {
      maxToolCalls: 10,
      generateWithTracing: async () => [resp(planJson), resp(synth)][Math.min(turn++, 1)]!,
      executeToolCall: executeSpy,
    };
    return { runner: r, executeSpy };
  };

  it("normalized-variant duplicate WRITE step executes exactly ONCE (no double-act)", async () => {
    // Two steps: same tool, args differing only by case/whitespace → collapsed to 1.
    const planJson = JSON.stringify([
      { tool: "send_message", args: { to: "Alice" }, description: "send to alice" },
      { tool: "send_message", args: { to: "alice" }, description: "send to alice again" }
    ]);
    const { runner: r, executeSpy } = runnerWithSpy(planJson, "Done.");
    const result = await executePlanExecuteLoop(r, context(), provider, writeRequest());
    expect(result.finalResponse.output).toBe("Done.");
    // The duplicate was collapsed: executeToolCall invoked exactly once.
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("counterfactual — two genuinely different WRITE steps execute TWICE (not over-merged)", async () => {
    const planJson = JSON.stringify([
      { tool: "send_message", args: { to: "Alice" }, description: "send to Alice" },
      { tool: "send_message", args: { to: "Bob" }, description: "send to Bob" }
    ]);
    const { runner: r, executeSpy } = runnerWithSpy(planJson, "Done.");
    const result = await executePlanExecuteLoop(r, context(), provider, writeRequest());
    expect(result.finalResponse.output).toBe("Done.");
    // Genuinely different args → both steps execute.
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });
});
