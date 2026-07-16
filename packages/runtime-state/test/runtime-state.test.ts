import { describe, expect, it } from "vitest";
import {
  InMemoryCheckpointStore,
  InMemoryHookTraceStore
} from "../src/index.js";

describe("InMemoryCheckpointStore", () => {
  it("rejects invalid retention limits instead of bypassing memory bounds", () => {
    for (const options of [
      { maxCheckpointsPerRun: 0 },
      { maxCheckpointsPerRun: Number.NaN },
      { maxRuns: -1 },
      { maxRuns: Number.POSITIVE_INFINITY }
    ]) {
      expect(() => new InMemoryCheckpointStore(options)).toThrow(RangeError);
    }
  });

  it("saves and replays checkpoints sorted by step", async () => {
    const store = new InMemoryCheckpointStore({ idFactory: sequentialIds("checkpoint") });

    await store.save({ runId: "run-1", state: { value: "third" }, step: 3 });
    await store.save({ runId: "run-1", state: { value: "first" }, step: 1 });
    await store.save({ runId: "run-1", state: { value: "second" }, step: 2 });

    expect((await store.findByRunId("run-1")).map((checkpoint) => checkpoint.step)).toEqual([1, 2, 3]);
  });

  it("upserts checkpoints by run and step to match the database uniqueness contract", async () => {
    const store = new InMemoryCheckpointStore();

    await store.save({ runId: "run-1", state: { value: "old" }, step: 1 });
    await store.save({ runId: "run-1", state: { value: "new" }, step: 1 });

    expect(await store.findByRunId("run-1")).toHaveLength(1);
    expect((await store.findLatestByRunId("run-1"))?.state).toEqual({ value: "new" });
  });

  it("keeps only the latest checkpoints per run when bounded", async () => {
    const store = new InMemoryCheckpointStore({ maxCheckpointsPerRun: 2 });

    await store.save({ runId: "run-1", state: { value: "one" }, step: 1 });
    await store.save({ runId: "run-1", state: { value: "two" }, step: 2 });
    await store.save({ runId: "run-1", state: { value: "three" }, step: 3 });

    expect((await store.findByRunId("run-1")).map((checkpoint) => checkpoint.step)).toEqual([2, 3]);
  });

  it("deletes checkpoints by run without affecting other runs", async () => {
    const store = new InMemoryCheckpointStore();

    await store.save({ runId: "run-1", state: {}, step: 1 });
    await store.save({ runId: "run-2", state: {}, step: 1 });
    await store.deleteByRunId("run-1");

    expect(await store.findByRunId("run-1")).toEqual([]);
    expect(await store.findByRunId("run-2")).toHaveLength(1);
  });
});

describe("InMemoryHookTraceStore", () => {
  it("rejects invalid trace limits instead of silently discarding or retaining traces", () => {
    for (const maxTraces of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new InMemoryHookTraceStore({ maxTraces })).toThrow(RangeError);
    }
  });

  it("records hook traces by run and keeps recent traces bounded", () => {
    const store = new InMemoryHookTraceStore({
      idFactory: sequentialIds("hook-trace"),
      maxTraces: 2,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    store.record({
      hookId: "first",
      lifecycle: "beforeStart",
      runId: "run-1",
      status: "completed"
    });
    store.record({
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      hookId: "second",
      lifecycle: "afterComplete",
      runId: "run-1",
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "failed",
      error: "hook failed"
    });
    store.record({
      completedAt: new Date("2026-01-01T00:00:02.000Z"),
      createdAt: new Date("2026-01-01T00:00:02.000Z"),
      hookId: "third",
      lifecycle: "onError",
      runId: "run-2",
      startedAt: new Date("2026-01-01T00:00:02.000Z"),
      status: "completed"
    });

    expect(store.listByRunId("run-1")).toEqual([
      expect.objectContaining({
        durationMs: 1_000,
        error: "hook failed",
        hookId: "second",
        status: "failed"
      })
    ]);
    expect(store.listRecent().map((trace) => trace.hookId)).toEqual(["third", "second"]);
  });
});

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
