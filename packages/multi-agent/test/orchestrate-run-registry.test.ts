import { describe, expect, it } from "vitest";

import {
  MultiAgentOrchestrator,
  RuleBasedAgentWorker,
  SubAgentRunRegistry,
  createWorkerResult,
  type AgentRunInput,
  type AgentRunResult
} from "../src/index.js";

function okWorker(id: string): RuleBasedAgentWorker {
  return new RuleBasedAgentWorker(id, `worker ${id}`, ["task"], async (input: AgentRunInput): Promise<AgentRunResult> =>
    createWorkerResult(id, `${id}-output`, input)
  );
}

function throwingWorker(id: string): RuleBasedAgentWorker {
  return new RuleBasedAgentWorker(id, `worker ${id}`, ["task"], async (): Promise<AgentRunResult> => {
    throw new Error(`${id} blew up`);
  });
}

function hangingWorker(id: string): RuleBasedAgentWorker {
  return new RuleBasedAgentWorker(id, `worker ${id}`, ["task"], () => new Promise<AgentRunResult>(() => undefined));
}

const taskInput: AgentRunInput = { messages: [{ content: "task", role: "user" }], model: "diagnostic" };

describe("MultiAgentOrchestrator wires SubAgentRunRegistry end-to-end", () => {
  for (const mode of ["sequential", "parallel"] as const) {
    it(`${mode}: a real run registers parent + child runs and transitions them to terminal status`, async () => {
      const registry = new SubAgentRunRegistry();
      const orchestrator = new MultiAgentOrchestrator({
        idFactory: () => "run-1",
        runRegistry: registry,
        workers: [okWorker("alpha"), okWorker("beta")]
      });

      // Before the run there is nothing in the registry — proves the entry is
      // created BY the run, not pre-seeded by the test.
      expect(registry.list()).toHaveLength(0);

      await orchestrator.run(taskInput, { mode });

      const parent = registry.get("run-1");
      expect(parent?.status).toBe("completed");
      expect(parent?.parentRunId).toBeUndefined();

      const children = registry.children("run-1");
      expect(children.map((child) => child.runId).sort()).toEqual(["run-1::alpha", "run-1::beta"]);
      expect(children.every((child) => child.status === "completed")).toBe(true);
      expect(registry.activeCount()).toBe(0);
    });
  }

  it("sequential: a worker that throws transitions its child run to failed; the parent still completes", async () => {
    const registry = new SubAgentRunRegistry();
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "run-2",
      runRegistry: registry,
      workers: [okWorker("good"), throwingWorker("bad")]
    });

    await orchestrator.run(taskInput, { mode: "sequential" });

    expect(registry.get("run-2::good")?.status).toBe("completed");
    const failed = registry.get("run-2::bad");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/blew up/u);
    // Run had a completed worker, so the orchestration (parent) succeeds.
    expect(registry.get("run-2")?.status).toBe("completed");
  });

  it("a hung worker hitting the per-worker deadline becomes a detectable timed-out run", async () => {
    const registry = new SubAgentRunRegistry();
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "run-3",
      runRegistry: registry,
      workerTimeoutMs: 30,
      workers: [okWorker("alive"), hangingWorker("stuck")]
    });

    await orchestrator.run(taskInput, { mode: "parallel" });

    expect(registry.get("run-3::alive")?.status).toBe("completed");
    const stuck = registry.get("run-3::stuck");
    expect(stuck?.status).toBe("timed-out");
    expect(stuck?.error).toMatch(/deadline/u);
    expect(registry.activeCount()).toBe(0);
  }, 3000);

  it("orchestration with no completed worker marks the parent run failed", async () => {
    const registry = new SubAgentRunRegistry();
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "run-4",
      runRegistry: registry,
      workers: [throwingWorker("x"), throwingWorker("y")]
    });

    await expect(orchestrator.run(taskInput, { mode: "sequential" })).rejects.toThrow();

    expect(registry.get("run-4")?.status).toBe("failed");
    expect(registry.get("run-4::x")?.status).toBe("failed");
    expect(registry.get("run-4::y")?.status).toBe("failed");
    expect(registry.activeCount()).toBe(0);
  });

  it("no registry provided ⇒ a normal run is unaffected (backward-compatible)", async () => {
    const orchestrator = new MultiAgentOrchestrator({
      workers: [okWorker("a"), okWorker("b")]
    });
    const result = await orchestrator.run(taskInput, { mode: "sequential" });
    expect(result.results.every((step) => step.status === "completed")).toBe(true);
  });
});
