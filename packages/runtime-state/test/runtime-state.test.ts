import { describe, expect, it, vi } from "vitest";
import { InMemoryCheckpointStore, InMemoryHookTraceStore, InMemoryPendingApprovalStore } from "../src/index.js";

describe("InMemoryPendingApprovalStore", () => {
  it("resolves a pending approval when approved", async () => {
    const store = new InMemoryPendingApprovalStore({
      defaultTimeoutMs: 5_000,
      idFactory: () => "approval-1"
    });
    const response = store.requestApproval({
      arguments: { amount: 10 },
      runId: "run-1",
      toolName: "write_record",
      userId: "user-1"
    });

    expect(store.listPending()).toHaveLength(1);
    expect(store.approve("approval-1", { amount: 5 })).toBe(true);
    await expect(response).resolves.toEqual({
      approved: true,
      modifiedArguments: { amount: 5 }
    });
    expect(store.countPending()).toBe(0);
  });

  it("resolves a pending approval when rejected", async () => {
    const store = new InMemoryPendingApprovalStore({ idFactory: () => "approval-2" });
    const response = store.requestApproval({
      arguments: {},
      runId: "run-1",
      toolName: "send_message",
      userId: "user-1"
    });

    expect(store.reject("approval-2", "Needs smaller scope")).toBe(true);
    await expect(response).resolves.toEqual({
      approved: false,
      reason: "Needs smaller scope"
    });
  });

  it("times out and cleans up unresolved approvals", async () => {
    vi.useFakeTimers();
    const store = new InMemoryPendingApprovalStore({
      defaultTimeoutMs: 100,
      idFactory: () => "approval-timeout"
    });
    const response = store.requestApproval({
      arguments: {},
      runId: "run-1",
      toolName: "slow_tool",
      userId: "user-1"
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(response).resolves.toMatchObject({
      approved: false,
      reason: "Approval timed out after 100ms"
    });
    expect(store.listPending()).toEqual([]);
    vi.useRealTimers();
  });

  it("evicts the oldest pending approval when maxPending is exceeded", async () => {
    const store = new InMemoryPendingApprovalStore({
      defaultTimeoutMs: 5_000,
      idFactory: sequentialIds("approval"),
      maxPending: 1
    });
    const first = store.requestApproval({
      arguments: {},
      runId: "run-1",
      toolName: "first_tool",
      userId: "user-1"
    });
    const second = store.requestApproval({
      arguments: {},
      runId: "run-2",
      toolName: "second_tool",
      userId: "user-1"
    });

    await expect(first).resolves.toMatchObject({
      approved: false,
      reason: expect.stringContaining("overflow")
    });
    expect(store.listPending().map((approval) => approval.id)).toEqual(["approval-2"]);
    expect(store.approve("approval-2")).toBe(true);
    await expect(second).resolves.toMatchObject({ approved: true });
  });
});

describe("InMemoryCheckpointStore", () => {
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
