import type { AgentRunInput, AgentRunResult, AgentRuntime } from "@muse/agent-core";
import type { AgentSpec } from "@muse/agent-specs";
import { MultiAgentOrchestrator } from "@muse/multi-agent";
import { describe, expect, it, vi } from "vitest";

import { buildTieredOrchestration, resolveOrchestrateTierModels, resolveTierCapacityProbe } from "../src/multi-agent-routes.js";

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

const SPECS = [
  spec("researcher", "Look up facts and definitions quickly"),
  spec("analyst", "Analyze the trade-offs and reason about the design")
];

async function modelsOf(workers: { id: string; run: (i: AgentRunInput) => Promise<AgentRunResult> }[]): Promise<Record<string, string | undefined>> {
  const orchestrator = new MultiAgentOrchestrator({ workers });
  const result = await orchestrator.run(
    { messages: [{ content: "go", role: "user" }], model: "ollama/qwen3:8b" },
    { mode: "parallel" }
  );
  return Object.fromEntries(result.results.map((s) => [s.workerId, s.result?.response.model]));
}

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

describe("resolveTierCapacityProbe", () => {
  it("reports both-tiers-fit by default", () => {
    expect(resolveTierCapacityProbe({})()).toBe(true);
  });

  it("reports single-model-host (collapse) when MUSE_TIER_SINGLE_MODEL_HOST is truthy", () => {
    expect(resolveTierCapacityProbe({ MUSE_TIER_SINGLE_MODEL_HOST: "1" })()).toBe(false);
    expect(resolveTierCapacityProbe({ MUSE_TIER_SINGLE_MODEL_HOST: "true" })()).toBe(false);
    expect(resolveTierCapacityProbe({ MUSE_TIER_SINGLE_MODEL_HOST: "yes" })()).toBe(false);
    expect(resolveTierCapacityProbe({ MUSE_TIER_SINGLE_MODEL_HOST: "0" })()).toBe(true);
  });
});

describe("buildTieredOrchestration", () => {
  it("when the host holds both tiers, each worker runs on the model classified from its role — two tiers in one run", async () => {
    const { workers, collapsedToHeavy } = await buildTieredOrchestration(SPECS, echoRuntime, MODELS, () => true);
    expect(collapsedToHeavy).toBe(false);
    const byId = await modelsOf(workers);
    expect(byId.researcher).toBe("ollama/qwen3:8b");
    expect(byId.analyst).toBe("ollama/qwen3.6:35b-a3b");
    expect(byId.researcher).not.toBe(byId.analyst);
  });

  it("when the host CANNOT hold both tiers, the run collapses to the single heavy model", async () => {
    const { workers, collapsedToHeavy } = await buildTieredOrchestration(SPECS, echoRuntime, MODELS, () => false);
    expect(collapsedToHeavy).toBe(true);
    const byId = await modelsOf(workers);
    expect(byId.researcher).toBe("ollama/qwen3.6:35b-a3b");
    expect(byId.analyst).toBe("ollama/qwen3.6:35b-a3b");
  });

  it("fails open to single-heavy when the capacity probe throws", async () => {
    const { workers, collapsedToHeavy } = await buildTieredOrchestration(
      SPECS,
      echoRuntime,
      MODELS,
      () => { throw new Error("probe down"); }
    );
    expect(collapsedToHeavy).toBe(true);
    const byId = await modelsOf(workers);
    expect(byId.researcher).toBe("ollama/qwen3.6:35b-a3b");
    expect(byId.analyst).toBe("ollama/qwen3.6:35b-a3b");
  });
});

// Confidence-driven runtime: records the model each run used and returns
// logprobs whose mean equals confByModel[model] — so a cascade fast worker's
// escalation decision is deterministic without a live model.
function confidenceRuntime(confByModel: Record<string, number>): { calls: string[]; runtime: AgentRuntime; lastInput?: AgentRunInput } {
  const state: { calls: string[]; runtime: AgentRuntime; lastInput?: AgentRunInput } = {
    calls: [],
    runtime: {
      run: async (input: AgentRunInput): Promise<AgentRunResult> => {
        state.calls.push(input.model);
        state.lastInput = input;
        const mean = confByModel[input.model] ?? -5;
        return {
          response: { id: "r", logprobs: [{ logprob: mean, token: "x" }], model: input.model, output: `ran on ${input.model}`, raw: {} },
          runId: input.runId ?? "run"
        };
      }
    } as unknown as AgentRuntime
  };
  return state;
}

const RESEARCHER_INPUT: AgentRunInput = { messages: [{ content: "define entropy", role: "user" }], model: MODELS.fast, runId: "c" };

describe("buildTieredOrchestration — opt-in cascade (MUSE_TIERED_CASCADE)", () => {
  it("escalates a LOW-confidence fast worker to the heavy model (runs fast, then heavy)", async () => {
    vi.stubEnv("MUSE_TIERED_CASCADE", "1");
    const env = confidenceRuntime({ [MODELS.fast]: -2.0, [MODELS.heavy]: -0.1 }); // fast below the -1.0 threshold
    const { workers } = await buildTieredOrchestration(SPECS, env.runtime, MODELS, () => true);
    const researcher = workers.find((w) => w.id === "researcher")!;
    const result = await researcher.run(RESEARCHER_INPUT);
    expect(env.calls).toEqual([MODELS.fast, MODELS.heavy]); // cascade: fast first, then escalate
    expect(result.response.model).toBe(MODELS.heavy);
    vi.unstubAllEnvs();
  });

  it("keeps a HIGH-confidence fast worker on the fast model (one call, the latency win)", async () => {
    vi.stubEnv("MUSE_TIERED_CASCADE", "1");
    const env = confidenceRuntime({ [MODELS.fast]: -0.2 }); // above threshold
    const { workers } = await buildTieredOrchestration(SPECS, env.runtime, MODELS, () => true);
    const researcher = workers.find((w) => w.id === "researcher")!;
    const result = await researcher.run(RESEARCHER_INPUT);
    expect(env.calls).toEqual([MODELS.fast]); // heavy never ran
    expect(result.response.model).toBe(MODELS.fast);
    vi.unstubAllEnvs();
  });

  it("requests logprobs on the fast pass (consumes the agent-run logprobs plumbing)", async () => {
    vi.stubEnv("MUSE_TIERED_CASCADE", "1");
    const env = confidenceRuntime({ [MODELS.fast]: -0.2 });
    const { workers } = await buildTieredOrchestration(SPECS, env.runtime, MODELS, () => true);
    await workers.find((w) => w.id === "researcher")!.run(RESEARCHER_INPUT);
    expect(env.lastInput?.logprobs).toBe(true);
    vi.unstubAllEnvs();
  });

  it("is OFF by default — the fast worker runs once, no logprobs, no escalation (byte-identical to today)", async () => {
    const env = confidenceRuntime({ [MODELS.fast]: -2.0, [MODELS.heavy]: -0.1 }); // low, but cascade off
    const { workers } = await buildTieredOrchestration(SPECS, env.runtime, MODELS, () => true);
    const result = await workers.find((w) => w.id === "researcher")!.run(RESEARCHER_INPUT);
    expect(env.calls).toEqual([MODELS.fast]); // no escalation despite low confidence
    expect(env.lastInput?.logprobs).toBeUndefined(); // logprobs not requested
    expect(result.response.model).toBe(MODELS.fast);
  });
});
