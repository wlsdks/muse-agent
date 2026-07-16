import { describe, expect, it } from "vitest";

import {
  InMemoryAgentMessageBus,
  InMemoryOrchestrationHistoryStore,
  MultiAgentOrchestrator,
  NoAgentWorkerError,
  RuleBasedAgentWorker,
  createWorkerResult,
  type OrchestrationHistoryEntry
} from "../src/index.js";

describe("InMemoryOrchestrationHistoryStore", () => {
  function makeEntry(runId: string, startedAtMs = 0): OrchestrationHistoryEntry {
    const startedAt = new Date(startedAtMs);
    const finishedAt = new Date(startedAtMs + 5);
    return {
      completedCount: 1,
      durationMs: 5,
      failedCount: 0,
      finishedAt,
      mode: "sequential",
      runId,
      startedAt,
      status: "completed",
      workerCount: 1
    };
  }

  it("records entries with newest first", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    store.record(makeEntry("first", 1));
    store.record(makeEntry("second", 2));
    expect(store.list().map((entry) => entry.runId)).toEqual(["second", "first"]);
  });

  it("limits the buffer to maxEntries with FIFO eviction of oldest", () => {
    const store = new InMemoryOrchestrationHistoryStore({ maxEntries: 2 });
    store.record(makeEntry("a", 1));
    store.record(makeEntry("b", 2));
    store.record(makeEntry("c", 3));
    expect(store.list().map((entry) => entry.runId)).toEqual(["c", "b"]);
  });

  it("list(limit) returns at most that many entries", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    for (let index = 0; index < 5; index += 1) {
      store.record(makeEntry(`run-${index}`, index));
    }
    expect(store.list(2).map((entry) => entry.runId)).toEqual(["run-4", "run-3"]);
  });

  it("rejects bad bounds", () => {
    expect(() => new InMemoryOrchestrationHistoryStore({ maxEntries: 0 })).toThrow(RangeError);
    const store = new InMemoryOrchestrationHistoryStore();
    expect(() => store.list(-1)).toThrow(RangeError);
  });

  it("clear() empties the buffer", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    store.record(makeEntry("only", 1));
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it("getByRunId returns the matching entry or undefined", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    store.record(makeEntry("alpha", 1));
    store.record(makeEntry("beta", 2));
    expect(store.getByRunId("beta")?.runId).toBe("beta");
    expect(store.getByRunId("alpha")?.runId).toBe("alpha");
    expect(store.getByRunId("missing")).toBeUndefined();
  });

  it("summary() returns zeros when the buffer is empty", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    expect(store.summary()).toEqual({
      avgDurationMs: 0,
      byMode: {
        parallel: { avgDurationMs: 0, runs: 0 },
        race: { avgDurationMs: 0, runs: 0 },
        sequential: { avgDurationMs: 0, runs: 0 }
      },
      completedRuns: 0,
      failedRuns: 0,
      lastRunAt: null,
      maxDurationMs: 0,
      minDurationMs: 0,
      p95DurationMs: 0,
      totalRuns: 0
    });
  });

  it("summary() aggregates totals, status split, durations, and per-mode runs", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    function record(runId: string, durationMs: number, status: "completed" | "failed", mode: "sequential" | "parallel", finishedMs: number): void {
      const startedAt = new Date(finishedMs - durationMs);
      const finishedAt = new Date(finishedMs);
      store.record({
        completedCount: status === "completed" ? 1 : 0,
        durationMs,
        failedCount: status === "completed" ? 0 : 1,
        finishedAt,
        mode,
        runId,
        startedAt,
        status,
        workerCount: 1
      });
    }
    record("a", 100, "completed", "sequential", 1_000);
    record("b", 200, "completed", "parallel", 2_000);
    record("c", 300, "failed", "sequential", 3_000);
    record("d", 400, "completed", "parallel", 4_000);

    const summary = store.summary();
    expect(summary.totalRuns).toBe(4);
    expect(summary.completedRuns).toBe(3);
    expect(summary.failedRuns).toBe(1);
    expect(summary.minDurationMs).toBe(100);
    expect(summary.maxDurationMs).toBe(400);
    expect(summary.avgDurationMs).toBe(250);
    expect(summary.byMode.sequential).toEqual({ avgDurationMs: 200, runs: 2 });
    expect(summary.byMode.parallel).toEqual({ avgDurationMs: 300, runs: 2 });
    expect(summary.lastRunAt).toBe(new Date(4_000).toISOString());
    expect(summary.p95DurationMs).toBe(400);
  });

  it("summary() p95 uses the nearest-rank percentile at scale (NOT just the max) and reports zeros for a mode with no entries", () => {
    const store = new InMemoryOrchestrationHistoryStore({ maxEntries: 100 });
    // 21 entries, durations 10..210, alternating sequential/parallel (race gets none).
    // p95 index = min(20, ceil(0.95*21)-1 = 19) = 19 → the 20th smallest = 200, NOT the max 210.
    // Every prior summary test had ≤4 entries, where p95 collapses to the max and the
    // ceil/-1/0.95/min-clamp arithmetic is indistinguishable from "return the maximum".
    for (let index = 1; index <= 21; index += 1) {
      store.record({
        completedCount: 1,
        durationMs: index * 10,
        failedCount: 0,
        finishedAt: new Date(index),
        mode: index % 2 === 1 ? "sequential" : "parallel",
        runId: `r${index.toString()}`,
        startedAt: new Date(0),
        status: "completed",
        workerCount: 1
      });
    }
    const summary = store.summary();
    expect(summary.maxDurationMs).toBe(210);
    expect(summary.minDurationMs).toBe(10);
    expect(summary.p95DurationMs).toBe(200); // strictly below the max — the percentile formula is exercised
    expect(summary.p95DurationMs).toBeLessThan(summary.maxDurationMs);
    // race never ran in this non-empty store — the empty-mode branch must still report zeros.
    expect(summary.byMode.race).toEqual({ avgDurationMs: 0, runs: 0 });
  });

  it("summary() ignores a NaN / Infinity durationMs from a poisoned upstream record — does not propagate to avg / p95 / min / max / byMode averages", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    function record(runId: string, durationMs: number, mode: "sequential" | "parallel", status: "completed" | "failed" = "completed"): void {
      store.record({
        completedCount: status === "completed" ? 1 : 0,
        durationMs,
        failedCount: status === "completed" ? 0 : 1,
        finishedAt: new Date(),
        mode,
        runId,
        startedAt: new Date(),
        status,
        workerCount: 1
      });
    }
    record("a", 100, "sequential");
    record("nan-row", Number.NaN, "sequential");
    record("b", 300, "parallel");
    record("inf-row", Number.POSITIVE_INFINITY, "parallel");
    const summary = store.summary();
    expect(summary.totalRuns).toBe(4);
    expect(Number.isFinite(summary.avgDurationMs), `avgDurationMs (${summary.avgDurationMs.toString()}) must be finite`).toBe(true);
    expect(summary.avgDurationMs).toBe(200);
    expect(summary.minDurationMs).toBe(100);
    expect(summary.maxDurationMs).toBe(300);
    expect(summary.p95DurationMs).toBe(300);
    expect(summary.byMode.sequential.avgDurationMs).toBe(100);
    expect(summary.byMode.sequential.runs).toBe(2);
    expect(summary.byMode.parallel.avgDurationMs).toBe(300);
    expect(summary.byMode.parallel.runs).toBe(2);
  });

  it("owns entry snapshots and ignores invalid completion timestamps in summary", () => {
    const store = new InMemoryOrchestrationHistoryStore();
    const entry = makeEntry("owned", 100);
    store.record(entry);

    entry.startedAt.setTime(1);
    entry.finishedAt.setTime(2);
    const read = store.getByRunId("owned")!;
    read.startedAt.setTime(3);
    read.finishedAt.setTime(4);

    expect(store.getByRunId("owned")).toMatchObject({
      finishedAt: new Date(105),
      startedAt: new Date(100)
    });

    store.record({ ...makeEntry("invalid-finished", 200), finishedAt: new Date(Number.NaN) });
    expect(store.summary().lastRunAt).toBe(new Date(105).toISOString());
  });
});

describe("MultiAgentOrchestrator history recording", () => {
  it("records a completed entry with worker counts and a positive duration", async () => {
    const store = new InMemoryOrchestrationHistoryStore();
    let nowMs = 1_000;
    const orchestrator = new MultiAgentOrchestrator({
      clock: () => new Date(nowMs += 10),
      historyStore: store,
      workers: [
        new RuleBasedAgentWorker("alpha", "Alpha", ["task"], (input) => createWorkerResult("alpha", "ok-a", input)),
        new RuleBasedAgentWorker("beta", "Beta", ["task"], (input) => createWorkerResult("beta", "ok-b", input))
      ]
    });

    const result = await orchestrator.run(
      { messages: [{ content: "task", role: "user" }], model: "model-1" },
      { mode: "parallel" }
    );

    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      completedCount: 2,
      failedCount: 0,
      mode: "parallel",
      runId: result.runId,
      status: "completed",
      workerCount: 2
    });
    expect(entries[0]?.durationMs).toBeGreaterThan(0);
  });

  it("records a failed entry when no worker completes", async () => {
    const store = new InMemoryOrchestrationHistoryStore();
    const orchestrator = new MultiAgentOrchestrator({
      historyStore: store,
      workers: [
        new RuleBasedAgentWorker("primary", "Primary", ["task"], () => {
          throw new Error("boom");
        })
      ]
    });

    await expect(
      orchestrator.run({ messages: [{ content: "task", role: "user" }], model: "model-1" })
    ).rejects.toBeInstanceOf(NoAgentWorkerError);

    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      completedCount: 0,
      failedCount: 1,
      mode: "sequential",
      status: "failed",
      workerCount: 1
    });
    expect(entries[0]?.error).toContain("No worker completed");
  });

  it("records a failed entry when the requested workerIds are unknown", async () => {
    const store = new InMemoryOrchestrationHistoryStore();
    const orchestrator = new MultiAgentOrchestrator({
      historyStore: store,
      workers: [new RuleBasedAgentWorker("alpha", "Alpha", ["task"], (input) => createWorkerResult("alpha", "ok", input))]
    });

    await expect(
      orchestrator.run(
        { messages: [{ content: "task", role: "user" }], model: "model-1" },
        { workerIds: ["does-not-exist"] }
      )
    ).rejects.toBeInstanceOf(NoAgentWorkerError);

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.workerCount).toBe(0);
  });

  it("does not record when no historyStore is provided", async () => {
    const orchestrator = new MultiAgentOrchestrator({
      workers: [
        new RuleBasedAgentWorker("alpha", "Alpha", ["task"], (input) => createWorkerResult("alpha", "ok", input))
      ]
    });
    await orchestrator.run({ messages: [{ content: "task", role: "user" }], model: "model-1" });
    // Nothing to assert — the absence of a thrown error proves the orchestrator
    // tolerates a missing store path.
  });

  it("snapshots the bus conversation onto the recorded entry", async () => {
    const store = new InMemoryOrchestrationHistoryStore();
    const messageBus = new InMemoryAgentMessageBus();
    const orchestrator = new MultiAgentOrchestrator({
      historyStore: store,
      messageBus,
      workers: [
        new RuleBasedAgentWorker("alpha", "Alpha", ["task"], (input) => createWorkerResult("alpha", "ok-a", input)),
        new RuleBasedAgentWorker("beta", "Beta", ["task"], (input) => createWorkerResult("beta", "ok-b", input))
      ]
    });

    const result = await orchestrator.run({
      messages: [{ content: "task", role: "user" }],
      model: "model-1"
    });

    const entry = store.getByRunId(result.runId);
    expect(entry?.conversation).toBeDefined();
    expect(entry?.conversation).toHaveLength(2);
    expect(entry?.conversation?.map((message) => message.sourceAgentId)).toEqual(["alpha", "beta"]);
  });
});
