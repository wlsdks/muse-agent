import { describe, expect, it, vi } from "vitest";

import {
  InMemoryBackgroundOrchestrationStore,
  MultiAgentOrchestrator,
  RuleBasedAgentWorker,
  SubAgentRunRegistry,
  createWorkerResult,
  type AgentRunInput,
  type AgentRunResult,
  type BackgroundOrchestrationRecord
} from "../src/index.js";

const taskInput: AgentRunInput = { messages: [{ content: "research the topic", role: "user" }], model: "diagnostic" };

/** A worker whose `run` resolves only once `release()` is called — lets a test
 *  control exactly when each sub-agent "settles" (for the near-simultaneous
 *  race case). */
function controllableWorker(id: string): { worker: RuleBasedAgentWorker; release: () => void; calls: AgentRunInput[] } {
  const calls: AgentRunInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const worker = new RuleBasedAgentWorker(id, `worker ${id}`, ["task"], async (input: AgentRunInput): Promise<AgentRunResult> => {
    calls.push(input);
    await gate;
    return createWorkerResult(id, `${id}-output`, input);
  });
  return { calls, release, worker };
}

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

async function waitForRecord(
  store: InMemoryBackgroundOrchestrationStore,
  orchestrationId: string,
  timeoutMs = 2000
): Promise<BackgroundOrchestrationRecord> {
  const start = Date.now();
  for (;;) {
    const record = store.get(orchestrationId);
    if (record) return record;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${orchestrationId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("MultiAgentOrchestrator.runBackground", () => {
  it("returns a handle immediately without waiting for any worker to settle", async () => {
    const a = controllableWorker("alpha");
    const b = controllableWorker("beta");
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "bg-1", workers: [a.worker, b.worker] });
    const store = new InMemoryBackgroundOrchestrationStore();

    const handle = orchestrator.runBackground(taskInput, { mode: "parallel" }, store);

    expect(handle).toEqual({ orchestrationId: "bg-1", subtaskCount: 2 });
    // Neither worker has been given a chance to be observed as "done" yet —
    // the store has nothing for this run because nobody has settled.
    expect(store.get("bg-1")).toBeUndefined();

    a.release();
    b.release();
    await waitForRecord(store, "bg-1");
  });

  it("consolidates into ONE record once the LAST worker settles, in the same fan-in shape `run` produces", async () => {
    const a = controllableWorker("alpha");
    const b = controllableWorker("beta");
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "bg-2", workers: [a.worker, b.worker] });
    const store = new InMemoryBackgroundOrchestrationStore();

    orchestrator.runBackground(taskInput, { mode: "parallel" }, store);

    a.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get("bg-2")).toBeUndefined(); // beta hasn't settled yet

    b.release();
    const record = await waitForRecord(store, "bg-2");
    expect(record.status).toBe("completed");
    expect(record.subtaskCount).toBe(2);
    if (record.status === "completed") {
      expect(record.results).toHaveLength(2);
      expect(record.results.every((r) => r.status === "completed")).toBe(true);
      expect(record.response.output).toContain("alpha");
      expect(record.response.output).toContain("beta");
    }
  });

  it("near-simultaneous settlement still fires consolidation exactly once (MAST termination)", async () => {
    const a = controllableWorker("alpha");
    const b = controllableWorker("beta");
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "bg-race", workers: [a.worker, b.worker] });
    const store = new InMemoryBackgroundOrchestrationStore();
    const completeSpy = vi.spyOn(store, "complete");

    orchestrator.runBackground(taskInput, { mode: "parallel" }, store);

    // Release both in the same microtask turn — as close to simultaneous as
    // Promise scheduling allows.
    a.release();
    b.release();

    await waitForRecord(store, "bg-race");
    // give any stray double-fire a chance to land before asserting
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.list().filter((r) => r.orchestrationId === "bg-race")).toHaveLength(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
  });

  it("a failed worker is captured into the consolidated result as a failed subtask, never silently swallowed", async () => {
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "bg-3", workers: [okWorker("good"), throwingWorker("bad")] });
    const store = new InMemoryBackgroundOrchestrationStore();

    const handle = orchestrator.runBackground(taskInput, { mode: "parallel" }, store);
    expect(handle.subtaskCount).toBe(2);

    const record = await waitForRecord(store, "bg-3");
    expect(record.status).toBe("completed"); // one worker still completed
    if (record.status === "completed") {
      const bad = record.results.find((r) => r.workerId === "bad");
      expect(bad?.status).toBe("failed");
      expect(bad?.error).toMatch(/blew up/u);
      const good = record.results.find((r) => r.workerId === "good");
      expect(good?.status).toBe("completed");
    }
  });

  it("every worker whose run exceeds the deadline is bounded (timeout), never hangs consolidation", async () => {
    const orchestrator = new MultiAgentOrchestrator({
      idFactory: () => "bg-4",
      workerTimeoutMs: 30,
      workers: [okWorker("alive"), hangingWorker("stuck")]
    });
    const store = new InMemoryBackgroundOrchestrationStore();

    orchestrator.runBackground(taskInput, { mode: "parallel" }, store);

    const record = await waitForRecord(store, "bg-4", 3000);
    expect(record.status).toBe("completed");
    if (record.status === "completed") {
      const stuck = record.results.find((r) => r.workerId === "stuck");
      expect(stuck?.status).toBe("failed");
      expect(stuck?.error).toMatch(/deadline/u);
    }
  }, 5000);

  it("all workers failing still records ONE consolidated failed record (fail-close, never a dangling promise)", async () => {
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "bg-5", workers: [throwingWorker("x"), throwingWorker("y")] });
    const store = new InMemoryBackgroundOrchestrationStore();

    orchestrator.runBackground(taskInput, { mode: "sequential" }, store);

    const record = await waitForRecord(store, "bg-5");
    expect(record.status).toBe("failed");
    if (record.status === "failed") {
      expect(record.error.length).toBeGreaterThan(0);
    }
  });

  it("no duplicated dispatch — each selected worker is invoked exactly once with distinct workerIds (no overlap)", async () => {
    const a = controllableWorker("alpha");
    const b = controllableWorker("beta");
    const c = controllableWorker("gamma");
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "bg-6", workers: [a.worker, b.worker, c.worker] });
    const store = new InMemoryBackgroundOrchestrationStore();

    const handle = orchestrator.runBackground(taskInput, { mode: "parallel" }, store);
    expect(handle.subtaskCount).toBe(3);

    a.release();
    b.release();
    c.release();
    const record = await waitForRecord(store, "bg-6");

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(c.calls).toHaveLength(1);
    // Each dispatched worker got its OWN distinct identity stamped into its input — no
    // two sub-agents were dispatched under the same identity (non-overlapping dispatch).
    const dispatchedIds = [...a.calls, ...b.calls, ...c.calls].map((input) => input.metadata?.selectedAgentId);
    expect(new Set(dispatchedIds).size).toBe(3);
    if (record.status === "completed") {
      const workerIds = record.results.map((r) => r.workerId);
      expect(new Set(workerIds).size).toBe(workerIds.length);
    }
  });

  it("registers parent + child runs in the SubAgentRunRegistry, same as the blocking path", async () => {
    const registry = new SubAgentRunRegistry();
    const orchestrator = new MultiAgentOrchestrator({ idFactory: () => "bg-7", runRegistry: registry, workers: [okWorker("alpha"), okWorker("beta")] });
    const store = new InMemoryBackgroundOrchestrationStore();

    orchestrator.runBackground(taskInput, { mode: "parallel" }, store);
    await waitForRecord(store, "bg-7");

    expect(registry.get("bg-7")?.status).toBe("completed");
    expect(registry.get("bg-7::alpha")?.status).toBe("completed");
    expect(registry.get("bg-7::beta")?.status).toBe("completed");
  });

  it("store.complete is idempotent per orchestrationId (defense in depth for exactly-once)", () => {
    const store = new InMemoryBackgroundOrchestrationStore();
    const first: BackgroundOrchestrationRecord = {
      finishedAt: new Date(),
      orchestrationId: "dup-1",
      response: { id: "r1", model: "diagnostic", output: "first" },
      results: [],
      status: "completed",
      subtaskCount: 1,
      workerIds: ["a"]
    };
    const second: BackgroundOrchestrationRecord = { ...first, response: { ...first.response, output: "second" } };

    store.complete(first);
    store.complete(second);

    expect(store.list()).toHaveLength(1);
    expect(store.get("dup-1")?.status).toBe("completed");
    if (store.get("dup-1")?.status === "completed") {
      expect((store.get("dup-1") as { response: { output: string } }).response.output).toBe("first");
    }
  });
});
