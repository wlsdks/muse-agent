import { DiagnosticModelProvider } from "@muse/model";
import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { ToolExecutor, ToolRegistry, type MuseTool } from "@muse/tools";
import { describe, expect, it, vi } from "vitest";

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

// RETURNS an "Error: …" string (does NOT throw) on the sentinel — exactly how an
// MCP tool's `isError` result surfaces (transport.ts prefixes "Error: ", the
// executor keeps status "completed"). The post-condition must catch this.
const softFailTool = (): MuseTool => ({
  definition: {
    description: "Echo a value; returns an Error string (no throw) on the sentinel.",
    inputSchema: { properties: { value: { type: "string" } }, required: ["value"], type: "object" },
    name: "echo_value",
    risk: "read",
  },
  execute: async (args) => {
    const value = String((args as { value: unknown }).value);
    if (value === "soft") return "Error: upstream service returned 503";
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
  tools: [{ description: tool.definition.description, inputSchema: tool.definition.inputSchema, name: tool.definition.name, risk: tool.definition.risk }],
});

// A READ (idempotent) tool that transiently fails on its FIRST call (returns an
// "Error: …" string, status "completed") and succeeds afterwards — the injected
// transient failure a bounded retry should recover.
const flakyReadTool = (calls: { n: number }): MuseTool => ({
  definition: {
    description: "Look something up; transiently fails once.",
    inputSchema: { properties: { q: { type: "string" } }, required: ["q"], type: "object" },
    name: "lookup",
    risk: "read",
  },
  execute: async (args) => {
    calls.n += 1;
    return calls.n === 1 ? "Error: upstream returned 503" : `result for ${String((args as { q: unknown }).q)}`;
  },
});

// A WRITE (non-idempotent) tool that fails — a retried send could double-act, so
// the plan must NEVER retry it (outbound-safety); it counts its calls to prove it.
const flakyWriteTool = (calls: { n: number }): MuseTool => ({
  definition: {
    description: "Send a message; fails.",
    inputSchema: { properties: { text: { type: "string" }, to: { type: "string" } }, required: ["to", "text"], type: "object" },
    name: "send_message",
    risk: "write",
  },
  execute: async () => {
    calls.n += 1;
    return "Error: send rejected (503)";
  },
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

  it("marks a NON-THROWING failure (status 'completed' but an 'Error: …' output) as unsuccessful — the post-condition the old status check missed", async () => {
    const tool = softFailTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    // step 2's tool returns "Error: …" WITHOUT throwing → status stays "completed".
    const planned = [
      { tool: "echo_value", args: { value: "ok" }, description: "good" },
      { tool: "echo_value", args: { value: "soft" }, description: "soft-fails (returns Error string)" },
    ];
    const prompt = steer(planned);
    const { events } = await drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)));

    const results = events.filter((e) => e.type === "plan-step-result") as Extract<PlanExecuteStreamEvent, { type: "plan-step-result" }>[];
    expect(results.map((e) => e.success)).toEqual([true, false]); // the soft failure is now caught
    expect(events.at(-1)?.type).toBe("synthesis-started"); // one real success ⇒ still synthesises
  });

  it("a SOLE non-throwing failed-effect step refuses synthesis (PLAN_ALL_STEPS_FAILED) instead of fabricating a done", async () => {
    const tool = softFailTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const planned = [{ tool: "echo_value", args: { value: "soft" }, description: "the only step soft-fails" }];
    const prompt = steer(planned);
    await expect(drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool))))
      .rejects.toThrow(/Every plan step failed/);
  });

  it("RECOVERS a transient failure on a READ (idempotent) step via a bounded retry — a 2-step task carries to a verified done THROUGH the injected failure", async () => {
    const calls = { n: 0 };
    const tool = flakyReadTool(calls);
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const planned = [
      { tool: "lookup", args: { q: "a" }, description: "lookup A (transiently fails once)" },
      { tool: "lookup", args: { q: "b" }, description: "lookup B" },
    ];
    const prompt = steer(planned);
    const { events } = await drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)));

    const results = events.filter((e) => e.type === "plan-step-result") as Extract<PlanExecuteStreamEvent, { type: "plan-step-result" }>[];
    expect(results.map((e) => e.success)).toEqual([true, true]); // step 1 RECOVERED on retry
    expect(calls.n).toBe(3); // step 1 took 2 attempts (fail → succeed); step 2 took 1
    expect(events.at(-1)?.type).toBe("synthesis-started"); // carried to a verified done
  });

  it("NEVER retries a non-idempotent WRITE step that fails (no double-act) — surfaces it honestly instead", async () => {
    const calls = { n: 0 };
    const tool = flakyWriteTool(calls);
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const planned = [{ tool: "send_message", args: { text: "hi", to: "y" }, description: "tell Y (fails)" }];
    const prompt = steer(planned);
    // the sole step fails and is NOT retried ⇒ all-failed ⇒ refuses synthesis
    await expect(drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool))))
      .rejects.toThrow(/Every plan step failed/);
    expect(calls.n).toBe(1); // executed EXACTLY once — a failed send is never plan-retried
  });

  it("StepEfficiency: a plan with an exact-duplicate step is deduplicated before execution (only one step runs)", async () => {
    const tool = echoTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });
    const planned = [
      { tool: "echo_value", args: { value: "x" }, description: "call" },
      { tool: "echo_value", args: { value: "x" }, description: "same call again" },
    ];
    const prompt = steer(planned);
    const { events } = await drain(streamPlanExecute(realRunner(provider, executor), context(prompt), provider, request(prompt, tool)));

    // The duplicate step is removed by dedupeExactSteps before execution.
    const executed = (events.filter((e) => e.type === "plan-step-executing") as Extract<PlanExecuteStreamEvent, { type: "plan-step-executing" }>[]);
    expect(executed).toHaveLength(1);
    // The raw plan-level metric still detects redundancy for observability.
    expect(redundantCalls(planned)).toBe(1);
    // a non-redundant plan (distinct args) scores zero
    expect(redundantCalls([
      { tool: "echo_value", args: { value: "x" } },
      { tool: "echo_value", args: { value: "y" } },
    ])).toBe(0);
  });
});

// ISR-LLM (arXiv:2308.13724) assembled-path tests: repair from validator errors,
// zero-executeToolCall on unrecoverable invalid plan, and happy-path no-repair.
// Uses a SCRIPTED provider (not DiagnosticModelProvider) to control exact plan
// sequences so the tests are deterministic and do not require Ollama.

/** Builds a JSON plan string for the scripted provider to emit. */
const planJson = (steps: readonly { tool: string; args: Record<string, unknown>; description: string }[]): string =>
  JSON.stringify(steps);

/** A scripted ModelProvider that emits a preset sequence of responses per call. */
function scriptedProvider(responses: string[]): ModelProvider {
  let callIndex = 0;
  return {
    generate: async (_request: ModelRequest): Promise<ModelResponse> => {
      const output = responses[callIndex] ?? "[]";
      callIndex += 1;
      return { output, toolCalls: [] };
    },
    id: "scripted",
    listModels: async () => [],
    stream: async function* () { /* not used */ }
  };
}

/** Tool with a required arg — used to test arg-presence validation. */
const requiredArgTool = (): MuseTool => ({
  definition: {
    description: "Save a note. Use when: storing text; do not use for: retrieval.",
    inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
    name: "save_note",
    risk: "write"
  },
  execute: async (args) => `saved: ${String((args as { text?: unknown }).text)}`
});

const scriptedRunner = (provider: ModelProvider, executor: ToolExecutor, executeSpy?: ReturnType<typeof vi.fn>): PlanExecuteRunner => ({
  executeToolCall: executeSpy
    ? async (ctx, toolCall) => {
        executeSpy();
        return { result: await executor.execute({ arguments: toolCall.arguments, context: { runId: ctx.runId }, id: toolCall.id, name: toolCall.name }), toolCall };
      }
    : async (ctx, toolCall) => ({
        result: await executor.execute({ arguments: toolCall.arguments, context: { runId: ctx.runId }, id: toolCall.id, name: toolCall.name }),
        toolCall
      }),
  generateWithTracing: async (_ctx, prov, req) => prov.generate(req),
  maxToolCalls: 5
});

const repairContext = (prompt: string): AgentRunContext => ({
  input: { messages: [{ content: prompt, role: "user" }], model: "scripted", metadata: {} },
  runId: "run-repair",
  startedAt: new Date("2026-01-01T00:00:00Z")
});

const repairRequest = (prompt: string, tool: MuseTool) => ({
  messages: [
    { content: "You are Muse.", role: "system" as const },
    { content: prompt, role: "user" as const }
  ],
  model: "scripted",
  tools: [{ description: tool.definition.description, inputSchema: tool.definition.inputSchema, name: tool.definition.name, risk: tool.definition.risk }]
});

describe("plan-execute ISR-LLM repair round (assembled-path, no Ollama)", () => {
  it("(a) first plan missing required arg → second planning prompt contains validator error text → valid repaired plan executes to synthesis", async () => {
    const tool = requiredArgTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });

    // First response: plan with missing required 'text' arg.
    // Second response: valid repaired plan with 'text' supplied.
    // Third response: synthesis output.
    const provider = scriptedProvider([
      planJson([{ tool: "save_note", args: {}, description: "save a note (missing arg)" }]),
      planJson([{ tool: "save_note", args: { text: "hello" }, description: "save a note (repaired)" }]),
      "The note has been saved."
    ]);

    const capturedRequests: ModelRequest[] = [];
    const trackingProvider: ModelProvider = {
      generate: async (req) => {
        capturedRequests.push(req);
        return provider.generate(req);
      },
      id: "tracking",
      listModels: async () => [],
      stream: async function* () { /* not used */ }
    };

    const prompt = "save a note for me";
    const runner = scriptedRunner(trackingProvider, executor);
    const { events } = await drain(streamPlanExecute(runner, repairContext(prompt), trackingProvider, repairRequest(prompt, tool)));

    // Assert the second planning call's prompt contains the validator error text.
    expect(capturedRequests.length).toBeGreaterThanOrEqual(2);
    const repairCallContent = capturedRequests[1]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(repairCallContent).toContain("missing required argument 'text'");

    // The run completed with a synthesis event.
    expect(events.at(-1)?.type).toBe("synthesis-started");
  });

  it("(b) repair plan is STILL invalid → PlanValidationFailedError thrown AND zero executeToolCall invocations", async () => {
    const tool = requiredArgTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });

    // Both plan responses omit the required arg.
    const provider = scriptedProvider([
      planJson([{ tool: "save_note", args: {}, description: "missing arg" }]),
      planJson([{ tool: "save_note", args: {}, description: "still missing arg" }])
    ]);

    const prompt = "save a note";
    const executeSpy = vi.fn();
    const runner = scriptedRunner(provider, executor, executeSpy);

    await expect(
      drain(streamPlanExecute(runner, repairContext(prompt), provider, repairRequest(prompt, tool)))
    ).rejects.toThrow(/missing required argument 'text'/);

    // The headline no-partial-side-effects assert: zero tool executions.
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("(c) valid first plan → EXACTLY ONE planning call (no repair, no extra latency on the happy path)", async () => {
    const tool = requiredArgTool();
    const executor = new ToolExecutor({ registry: new ToolRegistry([tool]) });

    // First response: valid plan. Second: synthesis. A third would indicate spurious repair.
    const provider = scriptedProvider([
      planJson([{ tool: "save_note", args: { text: "hello" }, description: "save it" }]),
      "Saved."
    ]);

    let planCallCount = 0;
    const trackingProvider: ModelProvider = {
      generate: async (req) => {
        // Detect planning calls by the presence of responseFormat (plan requests set it).
        if (req.responseFormat) planCallCount += 1;
        return provider.generate(req);
      },
      id: "tracking",
      listModels: async () => [],
      stream: async function* () { /* not used */ }
    };

    const prompt = "save a note";
    const runner = scriptedRunner(trackingProvider, executor);
    const { events } = await drain(streamPlanExecute(runner, repairContext(prompt), trackingProvider, repairRequest(prompt, tool)));

    expect(planCallCount).toBe(1);
    expect(events.at(-1)?.type).toBe("synthesis-started");
  });
});
