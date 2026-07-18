import { describe, expect, it } from "vitest";

import {
  InMemoryBackgroundOrchestrationStore,
  MultiAgentOrchestrator,
  OrchestrationCancelledError,
  RuleBasedAgentWorker,
  SubAgentRunRegistry,
  SupervisorAgent,
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

  it("parallel: cancellation by one worker prevents a not-yet-started sibling", async () => {
    const registry = new SubAgentRunRegistry();
    const secondWorkerRan = { value: false };
    const secondWorker = new RuleBasedAgentWorker("second", "worker second", ["task"], async (input) => {
      secondWorkerRan.value = true;
      return createWorkerResult("second", "second-output", input);
    });
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "run-parallel-cancel",
      runRegistry: registry,
      workers: [workerThatCancelsMidRun("first", registry, "run-parallel-cancel"), secondWorker]
    });

    await expect(orchestrator.run(taskInput, { mode: "parallel" })).rejects.toBeInstanceOf(OrchestrationCancelledError);
    expect(secondWorkerRan.value).toBe(false);
    expect(registry.get("run-parallel-cancel")?.status).toBe("cancelled");
  });

  it("background: a pre-cancelled run never starts a worker and records a terminal failure", async () => {
    const registry = new SubAgentRunRegistry();
    const store = new InMemoryBackgroundOrchestrationStore();
    const workerRan = { value: false };
    const worker = new RuleBasedAgentWorker("only", "worker only", ["task"], async (input) => {
      workerRan.value = true;
      return createWorkerResult("only", "output", input);
    });
    registry.register({ runId: "run-background-cancel" });
    registry.cancel("run-background-cancel");
    const orchestrator = new MultiAgentOrchestrator({ runRegistry: registry, workers: [worker] });

    orchestrator.runBackground({ ...taskInput, runId: "run-background-cancel" }, {}, store);

    await expect.poll(() => store.get("run-background-cancel")?.status).toBe("failed");
    expect(workerRan.value).toBe(false);
    expect(registry.get("run-background-cancel")?.status).toBe("cancelled");
  });
});

describe("SupervisorAgent cooperative cancellation", () => {
  it("blocks the initially selected worker when the input signal is already aborted", async () => {
    const controller = new AbortController();
    const workerRan = { value: false };
    const worker = new RuleBasedAgentWorker("only", "worker only", ["task"], async (input) => {
      workerRan.value = true;
      return createWorkerResult("only", "output", input);
    });
    const supervisor = new SupervisorAgent({ workers: [worker] });
    controller.abort();

    await expect(supervisor.run({ ...taskInput, signal: controller.signal })).rejects.toBeInstanceOf(OrchestrationCancelledError);
    expect(workerRan.value).toBe(false);
  });

  it("re-checks cancellation before a fallback worker starts", async () => {
    const controller = new AbortController();
    const fallbackRan = { value: false };
    const first = new RuleBasedAgentWorker("a-first", "worker first", ["task"], async () => {
      controller.abort();
      throw new Error("force fallback");
    });
    const fallback = new RuleBasedAgentWorker("z-fallback", "worker fallback", ["task"], async (input) => {
      fallbackRan.value = true;
      return createWorkerResult("z-fallback", "output", input);
    });
    const supervisor = new SupervisorAgent({ maxHandoffs: 1, workers: [first, fallback] });

    await expect(supervisor.run({ ...taskInput, signal: controller.signal })).rejects.toBeInstanceOf(OrchestrationCancelledError);
    expect(fallbackRan.value).toBe(false);
  });
});
