import { DiagnosticModelProvider } from "@muse/model";
import type { ModelProvider } from "@muse/model";
import { ToolExecutor, ToolRegistry, type MuseTool } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { streamPlanExecute, type PlanExecuteRunner, type PlanExecuteStreamEvent } from "../src/plan-execute-loop.js";
import type { AgentRunContext } from "../src/types.js";

// TRAJECTORY / step-efficiency eval on the REAL plan-execute assembly (agent-eval
// gap C remaining). The earlier gap-C test asserted the tool-LOOP trajectory with
// a scripted runner; here the REAL DiagnosticModelProvider generates the plan
// (steered by a DIAGNOSTIC_PLAN directive) and we drain `streamPlanExecute` to
// assert the ORDERED span sequence (plan-generated → per-step executing/result →
// synthesis-started), plan ADHERENCE (executed tools == planned, in order), and a
// StepEfficiency metric that flags a redundant re-call of the same (tool, args).

const echoTool = (): MuseTool => ({
  definition: {
    description: "Echo a value back.",
    inputSchema: { properties: { value: { type: "string" } }, required: ["value"], type: "object" },
    name: "echo_value",
    risk: "read",
  },
  execute: async (args) => `echo: ${String((args as { value: unknown }).value)}`,
});
// Echoes, but throws when value === "bad" — lets one plan have a mixed outcome.
const pickyTool = (): MuseTool => ({
  definition: {
    description: "Echo a value, but fail on the sentinel.",
    inputSchema: { properties: { value: { type: "string" } }, required: ["value"], type: "object" },
    name: "echo_value",
    risk: "read",
  },
  execute: async (args) => {
    const value = String((args as { value: unknown }).value);
    if (value === "bad") throw new Error("boom");
    return `echo: ${value}`;
  },
});

const steer = (steps: readonly { tool: string; args: Record<string, unknown>; description: string }[]): string =>
  `do the steps\n\nDIAGNOSTIC_PLAN=${JSON.stringify(steps)}`;

const context = (prompt: string): AgentRunContext => ({
  input: { messages: [{ content: prompt, role: "user" }], model: "diagnostic/smoke", metadata: {} },
  runId: "run-traj",
  startedAt: new Date("2026-01-01T00:00:00Z"),
});
const request = (prompt: string, tool: MuseTool) => ({
  messages: [
    { content: "You are Muse.", role: "system" as const },
    { content: prompt, role: "user" as const },
  ],
  model: "diagnostic/smoke",
  tools: [{ description: tool.definition.description, inputSchema: tool.definition.inputSchema, name: tool.definition.name }],
});

const realRunner = (provider: ModelProvider, executor: ToolExecutor): PlanExecuteRunner => ({
  executeToolCall: async (ctx, toolCall) => ({
    result: await executor.execute({ arguments: toolCall.arguments, context: { runId: ctx.runId }, id: toolCall.id, name: toolCall.name }),
    toolCall,
  }),
  generateWithTracing: async (_ctx, prov, req) => prov.generate(req),
  maxToolCalls: 5,
});

// Drain the generator: collect every yielded span event AND the final execution.
const drain = async (
  gen: AsyncGenerator<PlanExecuteStreamEvent, unknown>,
): Promise<{ events: PlanExecuteStreamEvent[]; value: unknown }> => {
  const events: PlanExecuteStreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, value: next.value };
};

// DeepEval-style StepEfficiency: count steps whose (tool, JSON args) repeats an
// earlier step — a redundant re-call the agent could have avoided.
const redundantCalls = (steps: readonly { tool: string; args: unknown }[]): number => {
  const seen = new Set<string>();
  let redundant = 0;
  for (const s of steps) {
    const key = `${s.tool}::${JSON.stringify(s.args)}`;
    if (seen.has(key)) redundant += 1;
    else seen.add(key);
  }
  return redundant;
};

describe("plan-execute trajectory (gap C — real assembly span sequence + step-efficiency)", () => {
  const provider = new DiagnosticModelProvider({ defaultModel: "diagnostic/smoke" });

  it("emits the ordered span trajectory for a 2-step plan and adheres to the plan", async () => {
    const tool = echoTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const planned = [
      { tool: "echo_value", args: { value: "a" }, description: "first" },
      { tool: "echo_value", args: { value: "b" }, description: "second" },
    ];
    const prompt = steer(planned);
    const { events } = await drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)));

    expect(events.map((e) => e.type)).toEqual([
      "plan-generated",
      "plan-step-executing",
      "plan-step-result",
      "plan-step-executing",
      "plan-step-result",
      "synthesis-started",
    ]);
    // plan-generated carries the plan the diagnostic produced — adherence anchor
    const generated = events[0] as Extract<PlanExecuteStreamEvent, { type: "plan-generated" }>;
    expect(generated.plan.map((s) => s.tool)).toEqual(["echo_value", "echo_value"]);
    // step spans run in plan order and all succeed
    const stepResults = events.filter((e) => e.type === "plan-step-result") as Extract<PlanExecuteStreamEvent, { type: "plan-step-result" }>[];
    expect(stepResults.map((e) => e.stepIndex)).toEqual([0, 1]);
    expect(stepResults.every((e) => e.success)).toBe(true);
  });

  it("a direct-answer (empty plan) trajectory is plan-generated → synthesis-started, no step spans", async () => {
    const tool = echoTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const prompt = "just chat\n\nDIAGNOSTIC_PLAN=[]";
    const { events } = await drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)));

    expect(events.map((e) => e.type)).toEqual(["plan-generated", "synthesis-started"]);
    expect((events[0] as Extract<PlanExecuteStreamEvent, { type: "plan-generated" }>).plan).toHaveLength(0);
  });

  it("marks the failing step's result span as unsuccessful, yet still synthesises (one step succeeded)", async () => {
    const tool = pickyTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    // succeed first, fail second: a mixed-outcome trajectory still reaches synthesis
    const planned = [
      { tool: "echo_value", args: { value: "ok" }, description: "good" },
      { tool: "echo_value", args: { value: "bad" }, description: "fails" },
    ];
    const prompt = steer(planned);
    const { events } = await drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)));

    const results = events.filter((e) => e.type === "plan-step-result") as Extract<PlanExecuteStreamEvent, { type: "plan-step-result" }>[];
    expect(results.map((e) => e.success)).toEqual([true, false]);
    expect(events.at(-1)?.type).toBe("synthesis-started"); // one success ⇒ still synthesises
  });

  it("StepEfficiency: a plan that re-calls the same (tool,args) is flagged as redundant", async () => {
    const tool = echoTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const planned = [
      { tool: "echo_value", args: { value: "x" }, description: "call" },
      { tool: "echo_value", args: { value: "x" }, description: "same call again" },
    ];
    const prompt = steer(planned);
    const { events } = await drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)));

    // the assembly faithfully runs both steps (no silent dedup) — the trajectory
    // exposes the redundancy for the metric to catch
    const executed = (events.filter((e) => e.type === "plan-step-executing") as Extract<PlanExecuteStreamEvent, { type: "plan-step-executing" }>[]);
    expect(executed).toHaveLength(2);
    expect(redundantCalls(planned)).toBe(1);
    // a non-redundant plan (distinct args) scores zero
    expect(redundantCalls([
      { tool: "echo_value", args: { value: "x" } },
      { tool: "echo_value", args: { value: "y" } },
    ])).toBe(0);
  });
});
