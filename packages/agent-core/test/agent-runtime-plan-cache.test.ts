import type { ModelProvider, ModelRequest, ModelResponse } from "@muse/model";
import { ToolRegistry } from "@muse/tools";
import { describe, expect, it } from "vitest";

import { createAgentRuntime, type CachedPlan, type PlanCacheProvider, type PlanStep } from "../src/index.js";

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
