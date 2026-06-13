import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { ToolExecutor, ToolRegistry, type MuseTool } from "@muse/tools";
import { describe, expect, it, vi } from "vitest";

import { validatePlan, validateStepDependencies, type PlanStep } from "../src/plan-execute.js";
import { streamPlanExecute, type PlanExecuteRunner, type PlanExecuteStreamEvent } from "../src/plan-execute-loop.js";
import type { AgentRunContext } from "../src/types.js";

// LLMCompiler (arXiv:2312.04511, Kim et al. ICML 2024):
// forward/dangling dependency-reference validation.

const makeStep = (tool: string, args: Record<string, unknown>, description = "step"): PlanStep => ({
  args: args as PlanStep["args"],
  description,
  tool
});

const tools = new Set(["echo_value", "save_note", "read_note"]);

// ---------------------------------------------------------------------------
// validateStepDependencies — unit
// ---------------------------------------------------------------------------

describe("validateStepDependencies — forward/dangling refs (LLMCompiler arXiv:2312.04511)", () => {

  it("non-vacuity: step 1 (i=0) with {{step2.output}} → exactly one error at stepIndex 0", () => {
    const steps = [
      makeStep("echo_value", { q: "{{step2.output}}" }),
      makeStep("echo_value", { q: "hello" })
    ];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ stepIndex: 0, tool: "echo_value" });
    expect(errs[0]?.reason).toMatch(/forward/);
  });

  it("dangling: <step 9> in a 1-step plan → exactly one dangling error at stepIndex 0", () => {
    const steps = [makeStep("echo_value", { q: "<step 9>" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ stepIndex: 0 });
    expect(errs[0]?.reason).toMatch(/dangling/);
  });

  it("backward ref NOT flagged: step 2 (i=1) with {{step1.output}} → zero errors", () => {
    const steps = [
      makeStep("echo_value", { q: "hello" }),
      makeStep("echo_value", { q: "{{step1.output}}" })
    ];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });

  it("counterfactual: flip {{step2}} to {{step1}} on step 2 → error disappears", () => {
    const stepsForward = [
      makeStep("echo_value", { q: "hello" }),
      makeStep("echo_value", { q: "{{step3}}" })  // forward ref (step 3 doesn't exist)
    ];
    const errsForward = validateStepDependencies(stepsForward);
    expect(errsForward.length).toBeGreaterThan(0);

    const stepsBackward = [
      makeStep("echo_value", { q: "hello" }),
      makeStep("echo_value", { q: "{{step1}}" })  // backward ref — ok
    ];
    const errsBackward = validateStepDependencies(stepsBackward);
    expect(errsBackward).toHaveLength(0);
  });

  it("additivity: plan with no references → zero dependency errors", () => {
    const steps = [
      makeStep("echo_value", { q: "hello" }),
      makeStep("echo_value", { q: "world" })
    ];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });

  // Angle-bracket variants
  it("angle-bracket form <step N> detected", () => {
    const steps = [makeStep("echo_value", { q: "<step 2>" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
  });

  it("angle-bracket form <result of step N> detected", () => {
    const steps = [makeStep("echo_value", { q: "<result of step 3>" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
  });

  it("Korean angle-bracket form <단계 N …> detected", () => {
    const steps = [makeStep("echo_value", { q: "<단계 2 결과>" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
  });

  it("explicit phrase 'step N output' detected", () => {
    const steps = [makeStep("echo_value", { q: "step 2 output" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
  });

  it("explicit phrase 'result of step N' detected", () => {
    const steps = [makeStep("echo_value", { q: "result of step 2" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
  });

  it("Korean phrase '단계 N 결과' detected", () => {
    const steps = [makeStep("echo_value", { q: "단계 2 결과" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(1);
  });

  it("bare $N (exactly the full value) is NOT treated as a ref — currency indistinguishable from step-ref", () => {
    // "$2" alone is currency-ambiguous; the grammar never flags bare $N to avoid
    // false-positives. Planners must use a delimited form to express step wiring.
    const steps = [makeStep("echo_value", { ref: "$2" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CURRENCY / DATA FALSE-POSITIVE GUARDS — must produce ZERO errors
// ---------------------------------------------------------------------------

describe("validateStepDependencies — currency/data false-positive guards", () => {

  it('price: "$2" embedded in prose (args: {price:"$2"}) — only if $2 IS the full value it IS flagged, but "$2" by itself standalone IS a ref in a >=2-step plan', () => {
    // The spec says bare $N standalone (entire trimmed value = "$N") IS a ref.
    // For args with currency EMBEDDED in prose it must NOT be flagged.
    // "$2" as the full value of "price" in a 1-step plan → dangling.
    // But "$2" embedded in "save $2" → not flagged.
    const stepsEmbedded = [makeStep("echo_value", { note: "$2 coffee" })];
    const errs = validateStepDependencies(stepsEmbedded);
    expect(errs).toHaveLength(0);
  });

  it('note: "$50 budget" → zero errors (currency embedded in prose)', () => {
    const steps = [makeStep("echo_value", { note: "$50 budget" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });

  it('msg: "save $5 per item" → zero errors (currency embedded in prose)', () => {
    const steps = [makeStep("echo_value", { msg: "save $5 per item" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });

  it('q: "step count is 3" → zero errors (plain prose with number, not a ref phrase)', () => {
    const steps = [makeStep("echo_value", { q: "step count is 3" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });

  it('amount: "$2 coffee" → zero errors (currency embedded in prose)', () => {
    const steps = [makeStep("echo_value", { amount: "$2 coffee" })];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });

  it("bare numeric mustache {{2025}} / {{0}} → zero errors (year/index template value, not a step ref)", () => {
    // {{N}} without the "step" keyword collides with a literal numeric
    // template value (a year, a zero-based index). The grammar requires
    // "step", so these legit args are not wrongly rejected.
    const steps = [
      makeStep("echo_value", { copyright: "{{2025}}" }),
      makeStep("echo_value", { idx: "{{0}}" })
    ];
    const errs = validateStepDependencies(steps);
    expect(errs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validatePlan integration — dep errors wired in
// ---------------------------------------------------------------------------

describe("validatePlan — dependency errors are wired in (additive, no existing check changed)", () => {

  it("forward ref makes validatePlan return valid=false", () => {
    const steps = [
      makeStep("echo_value", { q: "{{step2.output}}" }),
      makeStep("echo_value", { q: "plain" })
    ];
    const result = validatePlan({ availableToolNames: tools, steps });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.reason.includes("forward"))).toBe(true);
  });

  it("plan with no references → validatePlan errors unchanged from prior behaviour (zero dep errors)", () => {
    const steps = [
      makeStep("echo_value", { q: "hello" }),
      makeStep("echo_value", { q: "world" })
    ];
    const withDep = validatePlan({ availableToolNames: tools, steps });
    // No dep errors added; any existing errors (none here) unchanged.
    const depErrors = withDep.errors.filter((e) => e.reason.includes("forward") || e.reason.includes("dangling"));
    expect(depErrors).toHaveLength(0);
    expect(withDep.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Assembled-path: no-partial-side-effect proof
// ---------------------------------------------------------------------------
// A 2-step plan where step 1 is a WRITE tool and step 2 has a forward ref
// {{step3.output}} → validatePlan fails-closed via PlanValidationFailedError
// AND the write tool's effect is ABSENT (store unchanged).
// Counterfactual: without validateStepDependencies the write would execute.

const planJson = (steps: readonly { tool: string; args: Record<string, unknown>; description: string }[]): string =>
  JSON.stringify(steps);

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

const drain = async (
  gen: AsyncGenerator<PlanExecuteStreamEvent, unknown>
): Promise<{ events: PlanExecuteStreamEvent[]; value: unknown }> => {
  const events: PlanExecuteStreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, value: next.value };
};

describe("plan-execute assembled-path — forward-dep plan fails-closed with no partial side-effects", () => {

  it("step 1 is a WRITE tool + step 2 has {{step3.output}} forward ref → PlanValidationFailedError, write NOT executed", async () => {
    const writeCallCount = { n: 0 };

    const writeTool: MuseTool = {
      definition: {
        description: "Save a note. Use when: storing text; do not use for: retrieval.",
        inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
        name: "save_note",
        risk: "write"
      },
      execute: async (args) => {
        writeCallCount.n += 1;
        return `saved: ${String((args as { text?: unknown }).text)}`;
      }
    };

    const readTool: MuseTool = {
      definition: {
        description: "Read notes. Use when: fetching stored text.",
        inputSchema: { properties: { q: { type: "string" } }, required: ["q"], type: "object" },
        name: "read_note",
        risk: "read"
      },
      execute: async (args) => `notes: ${String((args as { q?: unknown }).q)}`
    };

    const executor = new ToolExecutor({ registry: new ToolRegistry([writeTool, readTool]) });

    // The broken plan: step 1 writes, step 2 has a forward ref to step 3 (doesn't exist).
    const brokenPlan = planJson([
      { tool: "save_note", args: { text: "important note" }, description: "write the note" },
      { tool: "read_note", args: { q: "{{step3.output}}" }, description: "use nonexistent step 3" }
    ]);

    // Both planning calls return the broken plan (repair also fails).
    const provider = scriptedProvider([brokenPlan, brokenPlan]);

    const executeSpy = vi.fn();
    const runner: PlanExecuteRunner = {
      executeToolCall: async (ctx, toolCall) => {
        executeSpy();
        return {
          result: await executor.execute({ arguments: toolCall.arguments, context: { runId: ctx.runId }, id: toolCall.id, name: toolCall.name }),
          toolCall
        };
      },
      generateWithTracing: async (_ctx, prov, req) => prov.generate(req),
      maxToolCalls: 5
    };

    const prompt = "save and read";
    const context: AgentRunContext = {
      input: { messages: [{ content: prompt, role: "user" }], model: "scripted", metadata: {} },
      runId: "run-dep-test",
      startedAt: new Date("2026-01-01T00:00:00Z")
    };
    const request = {
      messages: [
        { content: "You are Muse.", role: "system" as const },
        { content: prompt, role: "user" as const }
      ],
      model: "scripted",
      tools: [
        { description: writeTool.definition.description, inputSchema: writeTool.definition.inputSchema, name: writeTool.definition.name, risk: writeTool.definition.risk },
        { description: readTool.definition.description, inputSchema: readTool.definition.inputSchema, name: readTool.definition.name, risk: readTool.definition.risk }
      ]
    };

    // The plan must fail-close with PlanValidationFailedError.
    await expect(
      drain(streamPlanExecute(runner, context, provider, request))
    ).rejects.toThrow(/un-dispatchable/);

    // No-partial-side-effects: the write tool was NEVER executed.
    expect(executeSpy).not.toHaveBeenCalled();
    expect(writeCallCount.n).toBe(0);
  });

  it("counterfactual: without the forward ref the same write+read plan executes step 1 (write runs)", async () => {
    const writeCallCount = { n: 0 };

    const writeTool: MuseTool = {
      definition: {
        description: "Save a note. Use when: storing text; do not use for: retrieval.",
        inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" },
        name: "save_note",
        risk: "write"
      },
      execute: async (args) => {
        writeCallCount.n += 1;
        return `saved: ${String((args as { text?: unknown }).text)}`;
      }
    };

    const readTool: MuseTool = {
      definition: {
        description: "Read notes. Use when: fetching stored text.",
        inputSchema: { properties: { q: { type: "string" } }, required: ["q"], type: "object" },
        name: "read_note",
        risk: "read"
      },
      execute: async (args) => `notes: ${String((args as { q?: unknown }).q)}`
    };

    const executor = new ToolExecutor({ registry: new ToolRegistry([writeTool, readTool]) });

    // A valid plan with NO forward refs.
    const validPlan = planJson([
      { tool: "save_note", args: { text: "important note" }, description: "write the note" },
      { tool: "read_note", args: { q: "important" }, description: "read the note" }
    ]);

    // plan, plan (repair not needed but provider needs 3 calls: plan + synthesis).
    const provider = scriptedProvider([validPlan, "The note was saved and read."]);

    const runner: PlanExecuteRunner = {
      executeToolCall: async (ctx, toolCall) => ({
        result: await executor.execute({ arguments: toolCall.arguments, context: { runId: ctx.runId }, id: toolCall.id, name: toolCall.name }),
        toolCall
      }),
      generateWithTracing: async (_ctx, prov, req) => prov.generate(req),
      maxToolCalls: 5
    };

    const prompt = "save and read";
    const context: AgentRunContext = {
      input: { messages: [{ content: prompt, role: "user" }], model: "scripted", metadata: {} },
      runId: "run-dep-counterfactual",
      startedAt: new Date("2026-01-01T00:00:00Z")
    };
    const request = {
      messages: [
        { content: "You are Muse.", role: "system" as const },
        { content: prompt, role: "user" as const }
      ],
      model: "scripted",
      tools: [
        { description: writeTool.definition.description, inputSchema: writeTool.definition.inputSchema, name: writeTool.definition.name, risk: writeTool.definition.risk },
        { description: readTool.definition.description, inputSchema: readTool.definition.inputSchema, name: readTool.definition.name, risk: readTool.definition.risk }
      ]
    };

    const { events } = await drain(streamPlanExecute(runner, context, provider, request));

    // Valid plan runs to synthesis — the write tool WAS called.
    expect(events.at(-1)?.type).toBe("synthesis-started");
    expect(writeCallCount.n).toBe(1);
  });
});
