import { describe, expect, it } from "vitest";
import {
  createAdminAlertInsert,
  createAdminCostUsageInsert,
  createMetricAuditTrailInsert,
  createAdminSloInsert,
  InMemoryAdminOperationsStore,
  InMemoryMetricAuditEventStore,
  InMemoryCheckpointStore,
  InMemoryHookTraceStore,
  mapAdminAlertRow,
  mapAdminCostUsageRow,
  mapMetricAuditTrailRow,
  mapAdminSloRow
} from "../src/index.js";

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

describe("InMemoryAdminOperationsStore", () => {
  it("tracks alerts, SLO status, and cost summaries", async () => {
    const store = new InMemoryAdminOperationsStore({
      idFactory: (kind) => `${kind}-1`,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    await store.createAlert({
      message: "Budget threshold crossed",
      severity: "critical",
      target: "tenant-1"
    });
    const alertToResolve = await store.createAlert({
      id: "alert-resolve",
      message: "Latency threshold crossed",
      severity: "warning",
      target: "tenant-1"
    });
    const resolved = await store.resolveAlert(alertToResolve.id);
    const slo = await store.upsertSlo({
      actual: 94,
      id: "availability",
      name: "Availability",
      target: 99.9,
      window: "30d"
    });
    const costs = await store.recordCost({
      costUsd: "1.25000000",
      model: "provider/model"
    });

    expect(resolved).toMatchObject({ id: alertToResolve.id, status: "resolved" });
    expect(await store.listAlerts()).toHaveLength(2);
    expect(slo).toMatchObject({ id: "availability", status: "violated" });
    expect(costs).toEqual({
      byModel: { "provider/model": "1.25000000" },
      totalCostUsd: "1.25000000"
    });
  });
});

describe("metric event store", () => {
  it("records metric events in memory", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    const metricStore = new InMemoryMetricAuditEventStore({
      idFactory: sequentialIds("metric"),
      now: () => now
    });

    metricStore.record({
      kind: "eval-result",
      payload: { pass: true }
    });

    expect(metricStore.listRecent()).toMatchObject([
      {
        id: "metric-1",
        kind: "eval-result",
        payload: { pass: true }
      }
    ]);
  });
});

describe("Kysely admin operation mapping", () => {
  it("creates and maps admin operation rows without private data", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const options = {
      idFactory: (kind: "alert" | "slo" | "cost_usage") => `${kind}-1`,
      now: () => now
    };
    const alert = createAdminAlertInsert({
      message: "Budget threshold crossed",
      severity: "critical",
      target: "tenant-1"
    }, options);
    const slo = createAdminSloInsert({
      actual: 94,
      id: "availability",
      name: "Availability",
      target: 99.9,
      window: "30d"
    }, options);
    const cost = createAdminCostUsageInsert({
      costUsd: "1.25000000",
      model: "provider/model"
    }, options);
    const metric = createMetricAuditTrailInsert({
      createdAt: now,
      id: "metric-event-1",
      kind: "eval-result",
      payload: { pass: true }
    });

    expect(mapAdminAlertRow(alert)).toMatchObject({ id: "alert-1", status: "open", target: "tenant-1" });
    expect(mapAdminSloRow(slo)).toMatchObject({ id: "availability", status: "violated" });
    expect(mapAdminCostUsageRow(cost)).toEqual({
      costUsd: "1.25000000",
      model: "provider/model"
    });
    expect(mapMetricAuditTrailRow(metric)).toMatchObject({
      id: "metric-event-1",
      kind: "eval-result",
      payload: { pass: true }
    });
  });
});

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
