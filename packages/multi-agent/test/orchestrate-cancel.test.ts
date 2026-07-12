import { describe, expect, it } from "vitest";

import {
  MultiAgentOrchestrator,
  OrchestrationCancelledError,
  RuleBasedAgentWorker,
  SubAgentRunRegistry,
  createWorkerResult,
  type AgentRunInput,
  type AgentRunResult
} from "../src/index.js";

// User-requested cancellation is cooperative and registry-carried: the
// cancel flag must reach a run even when the caller holds a different
// orchestrator instance (the API builds one per request), remaining
// sequential workers must not start, and the run must finish as a
// distinct cancelled outcome — "I stopped it", never "it broke".

const taskInput: AgentRunInput = { messages: [{ content: "task", role: "user" }], model: "diagnostic" };

function workerThatCancelsMidRun(id: string, registry: SubAgentRunRegistry, runId: string): RuleBasedAgentWorker {
  return new RuleBasedAgentWorker(id, `worker ${id}`, ["task"], async (input: AgentRunInput): Promise<AgentRunResult> => {
    registry.cancel(runId);
    return createWorkerResult(id, `${id}-output`, input);
  });
}

function okWorker(id: string): RuleBasedAgentWorker {
  return new RuleBasedAgentWorker(id, `worker ${id}`, ["task"], async (input: AgentRunInput): Promise<AgentRunResult> =>
    createWorkerResult(id, `${id}-output`, input)
  );
}

describe("SubAgentRunRegistry.cancel", () => {
  it("cancels a running run exactly once; terminal statuses never flip", () => {
    const registry = new SubAgentRunRegistry();
    registry.register({ runId: "r1" });
    expect(registry.cancel("r1")).toBe(true);
    expect(registry.get("r1")).toMatchObject({ error: "cancelled by user", status: "cancelled" });
    expect(registry.cancel("r1")).toBe(false);
    // A late completion from the still-settling model call must not resurrect it.
    expect(registry.complete("r1")).toBe(false);
    expect(registry.get("r1")?.status).toBe("cancelled");
  });

  it("unknown run ids are refused", () => {
    expect(new SubAgentRunRegistry().cancel("ghost")).toBe(false);
  });
});

describe("MultiAgentOrchestrator cooperative cancellation", () => {
  it("sequential: cancelling mid-run skips the remaining workers and the run ends cancelled", async () => {
    const registry = new SubAgentRunRegistry();
    const secondWorkerRan = { value: false };
    const spyWorker = new RuleBasedAgentWorker("second", "worker second", ["task"], async (input: AgentRunInput) => {
      secondWorkerRan.value = true;
      return createWorkerResult("second", "second-output", input);
    });
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "run-c1",
      runRegistry: registry,
      workers: [workerThatCancelsMidRun("first", registry, "run-c1"), spyWorker]
    });

    await expect(orchestrator.run(taskInput, { mode: "sequential" })).rejects.toBeInstanceOf(OrchestrationCancelledError);
    expect(secondWorkerRan.value).toBe(false);
    expect(registry.get("run-c1")?.status).toBe("cancelled");
  });

  it("an uncancelled run is untouched by the new seams", async () => {
    const registry = new SubAgentRunRegistry();
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "run-c2",
      runRegistry: registry,
      workers: [okWorker("a"), okWorker("b")]
    });
    const result = await orchestrator.run(taskInput, { mode: "sequential" });
    expect(result.results.map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(registry.get("run-c2")?.status).toBe("completed");
  });
});
