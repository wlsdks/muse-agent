import { describe, expect, it } from "vitest";

import {
  InMemoryOrchestrationHistoryStore,
  MultiAgentOrchestrator,
  RuleBasedAgentWorker,
  createWorkerResult,
  detectFanInConflicts,
  detectFanInRedundancy
} from "../src/index.js";

// Two workers disagree on the same point; the embed maps "deadline" statements to an
// identical vector so the shared contradiction detector flags them.
const embed = async (t: string): Promise<readonly number[]> =>
  t.toLowerCase().includes("deadline") ? [1, 0] : [0, 1];

function disagreeingWorkers() {
  const a = new RuleBasedAgentWorker("Generalist", "Generalist", [], (input) =>
    createWorkerResult("Generalist", "the project deadline is tuesday", input)
  );
  const b = new RuleBasedAgentWorker("Critic", "Critic", [], (input) =>
    createWorkerResult("Critic", "the project deadline is wednesday", input)
  );
  return [a, b];
}

function redundantWorkers() {
  const a = new RuleBasedAgentWorker("Generalist", "Generalist", [], (input) =>
    createWorkerResult("Generalist", "the project deadline is tuesday", input)
  );
  const b = new RuleBasedAgentWorker("Critic", "Critic", [], (input) =>
    createWorkerResult("Critic", "the project deadline is tuesday", input)
  );
  return [a, b];
}

describe("MultiAgentOrchestrator — coordination outcomes persisted in the history entry", () => {
  it("records cross-worker REDUNDANCY in the history entry (the conflict-twin, queryable after the run)", async () => {
    const historyStore = new InMemoryOrchestrationHistoryStore();
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "hr", historyStore, workers: redundantWorkers() });
    const result = await orchestrator.run(
      { messages: [{ content: "when is the deadline?", role: "user" }], model: "m" },
      { mode: "sequential", detectRedundancies: (parts) => detectFanInRedundancy(parts, embed) }
    );
    const entry = historyStore.getByRunId(result.runId);
    expect(entry?.redundancies).toBeDefined();
    expect(entry?.redundancies?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(entry?.conflicts).toBeUndefined(); // identical outputs ≠ conflict
  });

  it("records cross-worker conflicts in the history entry (not just the live response)", async () => {
    const historyStore = new InMemoryOrchestrationHistoryStore();
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "h1", historyStore, workers: disagreeingWorkers() });
    const result = await orchestrator.run(
      { messages: [{ content: "when is the deadline?", role: "user" }], model: "m" },
      { mode: "sequential", detectConflicts: (parts) => detectFanInConflicts(parts, embed) }
    );
    const entry = historyStore.getByRunId(result.runId);
    expect(entry?.conflicts).toBeDefined();
    expect(entry?.conflicts?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(entry?.conflicts?.join(" ")).toContain("Generalist");
  });

  it("records the objective-coverage verdict (verificationSatisfied) in the history entry", async () => {
    const historyStore = new InMemoryOrchestrationHistoryStore();
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "h2", historyStore, workers: disagreeingWorkers() });
    const result = await orchestrator.run(
      { messages: [{ content: "when is the deadline?", role: "user" }], model: "m" },
      {
        mode: "sequential",
        synthesizeFinalAnswer: async () => "deadline tuesday",
        verifyFinalAnswer: async () => ({ missing: "the wednesday view", satisfied: false })
      }
    );
    const entry = historyStore.getByRunId(result.runId);
    expect(entry?.verificationSatisfied).toBe(false);
  });

  it("a clean run records NEITHER field (no noise)", async () => {
    const historyStore = new InMemoryOrchestrationHistoryStore();
    const a = new RuleBasedAgentWorker("Generalist", "Generalist", [], (input) =>
      createWorkerResult("Generalist", "Redis caching is fast.", input)
    );
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "h3", historyStore, workers: [a] });
    const result = await orchestrator.run({ messages: [{ content: "x", role: "user" }], model: "m" }, { mode: "sequential" });
    const entry = historyStore.getByRunId(result.runId);
    expect(entry?.conflicts).toBeUndefined();
    expect(entry?.verificationSatisfied).toBeUndefined();
  });
});
