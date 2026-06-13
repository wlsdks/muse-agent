import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createAgentRuntime, type CachedPlan, type PlanCacheProvider, type PlanStep } from "../src/index.js";

type Recorded = { userId: string; prompt: string; steps: readonly PlanStep[] };

function planResponse(steps: readonly PlanStep[]): ModelResponse {
  return { id: "plan", model: "m", output: JSON.stringify(steps) };
}
function answerResponse(text: string): ModelResponse {
  return { id: "answer", model: "m", output: text };
}

function sequenceProvider(responses: readonly ModelResponse[], onGenerate?: (r: ModelRequest) => void): ModelProvider {
  let index = 0;
  return {
    id: "seq",
    async generate(request) {
      onGenerate?.(request);
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return response;
    },
    async listModels() { return []; },
    async *stream() {}
  };
}

function runtimeWith(provider: ModelProvider, planCacheProvider: PlanCacheProvider) {
  const toolRegistry = new ToolRegistry([
    {
      definition: { description: "Search notes", inputSchema: { type: "object" }, name: "notes_search", risk: "read" as const },
      execute: async () => ({ hits: ["note"] })
    }
  ]);
  return createAgentRuntime({ modelProvider: provider, planCacheProvider, toolRegistry });
}

describe("Agentic Plan Caching wired into plan-execute (arXiv 2506.14852)", () => {
  it("records the executed plan after a successful plan-execute run", async () => {
    const recorded: { userId: string; prompt: string; steps: readonly PlanStep[] }[] = [];
    const provider: PlanCacheProvider = {
      findSimilarPlan: async () => undefined,
      recordPlan: async (userId, prompt, steps) => { recorded.push({ prompt, steps, userId }); }
    };
    const runtime = runtimeWith(
      sequenceProvider([
        planResponse([{ args: { query: "Q3" }, description: "find notes", tool: "notes_search" }]),
        answerResponse("Here is the summary.")
      ]),
      provider
    );

    await runtime.run({
      messages: [{ content: "summarize my Q3 budget notes", role: "user" }],
      metadata: { agentMode: "plan_execute", userId: "stark" },
      model: "provider/model",
      runId: "apc-record"
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.userId).toBe("stark");
    expect(recorded[0]!.prompt).toBe("summarize my Q3 budget notes");
    expect(recorded[0]!.steps[0]!.tool).toBe("notes_search");
  });

  it("injects a similar past plan into the planning prompt as an exemplar", async () => {
    const requests: ModelRequest[] = [];
    const cached: CachedPlan = {
      prompt: "summarize my Q3 budget notes",
      steps: [{ args: { query: "Q3" }, description: "find notes", tool: "notes_search" }]
    };
    const provider: PlanCacheProvider = {
      findSimilarPlan: async () => cached,
      recordPlan: async () => undefined
    };
    const runtime = runtimeWith(
      sequenceProvider([
        planResponse([{ args: { query: "Q4" }, description: "find notes", tool: "notes_search" }]),
        answerResponse("Here is the Q4 summary.")
      ], (request) => requests.push(request)),
      provider
    );

    await runtime.run({
      messages: [{ content: "summarize my Q4 budget notes", role: "user" }],
      metadata: { agentMode: "plan_execute", userId: "stark" },
      model: "provider/model",
      runId: "apc-inject"
    });

    const planningSystem = requests[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(planningSystem).toContain("[Similar Past Plan]");
    expect(planningSystem).toContain("notes_search");
  });

  it("no userId ⇒ neither records nor injects (conservative)", async () => {
    const recorded: unknown[] = [];
    let findCalls = 0;
    const provider: PlanCacheProvider = {
      findSimilarPlan: async () => { findCalls += 1; return undefined; },
      recordPlan: async () => { recorded.push(1); }
    };
    const runtime = runtimeWith(
      sequenceProvider([
        planResponse([{ args: {}, description: "find notes", tool: "notes_search" }]),
        answerResponse("ok")
      ]),
      provider
    );

    await runtime.run({
      messages: [{ content: "summarize notes", role: "user" }],
      metadata: { agentMode: "plan_execute" },
      model: "provider/model",
      runId: "apc-no-user"
    });

    expect(recorded).toHaveLength(0);
    expect(findCalls).toBe(0);
  });
});

// AWM outcome-conditioning: only steps from a SUCCESSFUL trajectory are cached.
describe("AWM outcome-conditioned plan caching (arXiv:2409.07429)", () => {
  // Two tools: step_ok always succeeds; step_fail returns an effect-failed output.
  function runtimeWithTwoTools(provider: ModelProvider, cacheProvider: PlanCacheProvider) {
    const toolRegistry = new ToolRegistry([
      {
        definition: { description: "Step that always succeeds", inputSchema: { type: "object" }, name: "step_ok", risk: "read" as const },
        execute: async () => "result ok"
      },
      {
        definition: { description: "Step that effect-fails", inputSchema: { type: "object" }, name: "step_fail", risk: "read" as const },
        // Returns "Error: …" — status stays "completed" but classifyStepEffect marks it effectFailed.
        execute: async () => "Error: simulated effect failure"
      }
    ]);
    return createAgentRuntime({ modelProvider: provider, planCacheProvider: cacheProvider, toolRegistry });
  }

  // Distinct args prevent dedupeExactSteps (keyed on tool::args) from collapsing them.
  const step1: PlanStep = { args: { q: "first" }, description: "step one", tool: "step_ok" };
  const step2Fail: PlanStep = { args: {}, description: "step two fails", tool: "step_fail" };
  const step2Ok: PlanStep = { args: { q: "second" }, description: "step two succeeds", tool: "step_ok" };

  it("failed step is excluded from cached exemplar (only successful step recorded)", async () => {
    const recorded: Recorded[] = [];
    const cacheProvider: PlanCacheProvider = {
      findSimilarPlan: async () => undefined,
      recordPlan: async (userId, prompt, steps) => { recorded.push({ prompt, steps, userId }); }
    };
    const runtime = runtimeWithTwoTools(
      sequenceProvider([
        planResponse([step1, step2Fail]),
        answerResponse("answer with partial success")
      ]),
      cacheProvider
    );

    await runtime.run({
      messages: [{ content: "do two steps", role: "user" }],
      metadata: { agentMode: "plan_execute", userId: "stark" },
      model: "provider/model",
      runId: "awm-fail-excluded"
    });

    expect(recorded).toHaveLength(1);
    // Only step_ok (step1) should be cached; step_fail is excluded.
    expect(recorded[0]!.steps).toHaveLength(1);
    expect(recorded[0]!.steps[0]!.tool).toBe("step_ok");
  });

  it("counterfactual: when step-2 succeeds, both steps are cached", async () => {
    const recorded: Recorded[] = [];
    const cacheProvider: PlanCacheProvider = {
      findSimilarPlan: async () => undefined,
      recordPlan: async (userId, prompt, steps) => { recorded.push({ prompt, steps, userId }); }
    };
    const runtime = runtimeWithTwoTools(
      sequenceProvider([
        planResponse([step1, step2Ok]),
        answerResponse("answer with full success")
      ]),
      cacheProvider
    );

    await runtime.run({
      messages: [{ content: "do two steps", role: "user" }],
      metadata: { agentMode: "plan_execute", userId: "stark" },
      model: "provider/model",
      runId: "awm-both-succeed"
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.steps).toHaveLength(2);
    expect(recorded[0]!.steps[0]!.tool).toBe("step_ok");
    expect(recorded[0]!.steps[1]!.tool).toBe("step_ok");
  });

  it("zero successful steps ⇒ nothing cached (all-failed path throws before cache)", async () => {
    const recorded: Recorded[] = [];
    const cacheProvider: PlanCacheProvider = {
      findSimilarPlan: async () => undefined,
      recordPlan: async (userId, prompt, steps) => { recorded.push({ prompt, steps, userId }); }
    };
    const runtime = runtimeWithTwoTools(
      sequenceProvider([
        planResponse([step2Fail]),
        answerResponse("unreachable")
      ]),
      cacheProvider
    );

    // All-failed throws PLAN_ALL_STEPS_FAILED before reaching the cache call.
    await expect(runtime.run({
      messages: [{ content: "only failing step", role: "user" }],
      metadata: { agentMode: "plan_execute", userId: "stark" },
      model: "provider/model",
      runId: "awm-all-fail"
    })).rejects.toMatchObject({ code: "PLAN_ALL_STEPS_FAILED" });

    expect(recorded).toHaveLength(0);
  });
});
