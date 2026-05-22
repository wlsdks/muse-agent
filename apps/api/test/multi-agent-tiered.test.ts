import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import type { AgentSpec } from "@muse/agent-specs";
import { MultiAgentOrchestrator } from "@muse/multi-agent";
import { describe, expect, it } from "vitest";

import { buildSpecWorkers, resolveOrchestrateTierModels } from "../src/multi-agent-routes.js";

function spec(name: string, description: string): AgentSpec {
  return {
    createdAt: new Date(0),
    description,
    enabled: true,
    id: name,
    independentExecution: false,
    keywords: [],
    mode: "react",
    name,
    toolNames: [],
    updatedAt: new Date(0)
  };
}

// Echoes back the model it was dispatched with, so a test can prove a
// worker executed on its tier model.
const echoRuntime: AgentRuntime = {
  run: async (input: AgentRunInput): Promise<AgentRunResult> => ({
    response: { id: "r", model: input.model, output: `ran on ${input.model}`, raw: {} },
    runId: input.runId ?? "run"
  })
} as unknown as AgentRuntime;

const MODELS = { fast: "ollama/qwen3:8b", heavy: "ollama/qwen3.6:35b-a3b" } as const;

describe("resolveOrchestrateTierModels", () => {
  it("falls back to the default model for any tier env unset or blank", () => {
    expect(resolveOrchestrateTierModels("def", {})).toEqual({ fast: "def", heavy: "def" });
    expect(resolveOrchestrateTierModels("def", { MUSE_FAST_MODEL: "  ", MUSE_HEAVY_MODEL: "" }))
      .toEqual({ fast: "def", heavy: "def" });
  });

  it("uses the tier env models when present (trimmed)", () => {
    expect(resolveOrchestrateTierModels("def", { MUSE_FAST_MODEL: " a ", MUSE_HEAVY_MODEL: "b" }))
      .toEqual({ fast: "a", heavy: "b" });
  });
});

describe("buildSpecWorkers tiering", () => {
  const specs = [
    spec("researcher", "Look up facts and definitions quickly"),
    spec("analyst", "Analyze the trade-offs and reason about the design")
  ];

  it("without tier models, dispatches every worker on the run-default model (unchanged behaviour)", async () => {
    const workers = buildSpecWorkers(specs, echoRuntime);
    const orchestrator = new MultiAgentOrchestrator({ workers });
    const result = await orchestrator.run(
      { messages: [{ content: "go", role: "user" }], model: "ollama/qwen3:8b" },
      { mode: "parallel" }
    );
    const byId = Object.fromEntries(result.results.map((s) => [s.workerId, s.result?.response.model]));
    expect(byId.researcher).toBe("ollama/qwen3:8b");
    expect(byId.analyst).toBe("ollama/qwen3:8b");
  });

  it("with tier models, each worker runs on the model classified from its role — two tiers in one run", async () => {
    const workers = buildSpecWorkers(specs, echoRuntime, MODELS);
    const orchestrator = new MultiAgentOrchestrator({ workers });
    const result = await orchestrator.run(
      { messages: [{ content: "go", role: "user" }], model: "ollama/qwen3:8b" },
      { mode: "parallel" }
    );
    const byId = Object.fromEntries(result.results.map((s) => [s.workerId, s.result?.response.model]));
    // "Look up …" → fast; "Analyze …" → heavy.
    expect(byId.researcher).toBe("ollama/qwen3:8b");
    expect(byId.analyst).toBe("ollama/qwen3.6:35b-a3b");
    expect(byId.researcher).not.toBe(byId.analyst);
  });

  it("defaults an unrecognised role to the heavy tier (never silently downgrades)", async () => {
    const workers = buildSpecWorkers([spec("scribe", "writes things down")], echoRuntime, MODELS);
    const orchestrator = new MultiAgentOrchestrator({ workers });
    const result = await orchestrator.run(
      { messages: [{ content: "go", role: "user" }], model: "ollama/qwen3:8b" },
      { mode: "parallel" }
    );
    expect(result.results[0]?.result?.response.model).toBe("ollama/qwen3.6:35b-a3b");
  });
});
