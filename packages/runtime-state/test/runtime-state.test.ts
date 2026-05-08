import { describe, expect, it, vi } from "vitest";
import {
  createAdminAlertInsert,
  createAdminAuditInsert,
  createAdminCostUsageInsert,
  createMetricAuditTrailInsert,
  createAdminSloInsert,
  createAdminTenantInsert,
  InMemoryAdminAuditStore,
  InMemoryAdminOperationsStore,
  InMemoryMetricAuditEventStore,
  InMemoryCheckpointStore,
  InMemoryHookTraceStore,
  InMemoryPendingApprovalStore,
  mapAdminAlertRow,
  mapAdminAuditRow,
  mapAdminCostUsageRow,
  mapMetricAuditTrailRow,
  mapAdminSloRow,
  mapAdminTenantRow
} from "../src/index.js";

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

describe("InMemoryAdminOperationsStore", () => {
  it("tracks tenants, alerts, SLO status, and cost summaries", async () => {
    const store = new InMemoryAdminOperationsStore({
      idFactory: (kind) => `${kind}-1`,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const tenant = await store.upsertTenant({
      id: "tenant-1",
      monthlyBudgetUsd: "100.00000000",
      name: "Tenant One"
    });
    const alert = await store.createAlert({
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
    const acknowledged = await store.acknowledgeAlert(alert.id);
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
      model: "provider/model",
      tenantId: "tenant-1"
    });

    expect(tenant).toMatchObject({ id: "tenant-1", status: "active" });
    expect(await store.listTenants()).toHaveLength(1);
    expect(acknowledged).toMatchObject({ id: alert.id, status: "acknowledged" });
    expect(resolved).toMatchObject({ id: alertToResolve.id, status: "resolved" });
    expect(await store.listAlerts()).toHaveLength(2);
    expect(slo).toMatchObject({ id: "availability", status: "violated" });
    expect(costs).toEqual({
      byModel: { "provider/model": "1.25000000" },
      byTenant: { "tenant-1": "1.25000000" },
      totalCostUsd: "1.25000000"
    });
  });
});

describe("admin audit and metric event stores", () => {
  it("stores bounded admin audits and metric events in memory", () => {
    const now = new Date("2026-05-06T00:00:00.000Z");
    const auditStore = new InMemoryAdminAuditStore({
      idFactory: sequentialIds("audit"),
      maxAudits: 1,
      now: () => now
    });
    const metricStore = new InMemoryMetricAuditEventStore({
      idFactory: sequentialIds("metric"),
      now: () => now
    });

    auditStore.record({
      action: "update",
      actor: "admin-1",
      category: "input_guard"
    });
    auditStore.record({
      action: "simulate",
      actor: "admin-1",
      category: "input_guard"
    });
    metricStore.record({
      kind: "eval-result",
      payload: { pass: true },
      tenantId: "tenant-1"
    });

    expect(auditStore.listRecent()).toMatchObject([{ action: "SIMULATE", id: "audit-2" }]);

    const queryAll = auditStore.query({ limit: 10 });
    expect(queryAll.total).toBe(1);
    expect(queryAll.items.map((entry) => entry.action)).toEqual(["SIMULATE"]);

    const filteredByCategory = auditStore.query({ category: "input_guard", limit: 10 });
    expect(filteredByCategory.total).toBe(1);

    const filteredByAction = auditStore.query({ action: "simulate", limit: 10 });
    expect(filteredByAction.items.map((entry) => entry.action)).toEqual(["SIMULATE"]);

    const noMatch = auditStore.query({ category: "missing", limit: 10 });
    expect(noMatch.total).toBe(0);
    expect(noMatch.items).toEqual([]);
    expect(metricStore.listRecent()).toMatchObject([
      {
        id: "metric-1",
        kind: "eval-result",
        payload: { pass: true },
        tenantId: "tenant-1"
      }
    ]);
  });
});

describe("Kysely admin operation mapping", () => {
  it("creates and maps admin operation rows without private data", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const options = {
      idFactory: (kind: "tenant" | "alert" | "slo" | "cost_usage") => `${kind}-1`,
      now: () => now
    };
    const tenant = createAdminTenantInsert({
      id: "tenant-1",
      monthlyBudgetUsd: "100.00000000",
      name: "Tenant One"
    }, options);
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
      model: "provider/model",
      tenantId: "tenant-1"
    }, options);
    const audit = createAdminAuditInsert({
      action: "update",
      actor: "admin-1",
      category: "input_guard",
      resourceId: "stage-1",
      resourceType: "guard_stage"
    }, {
      idFactory: () => "admin-audit-1",
      now: () => now
    });
    const metric = createMetricAuditTrailInsert({
      createdAt: now,
      id: "metric-event-1",
      kind: "eval-result",
      payload: { pass: true },
      tenantId: "tenant-1"
    });

    expect(mapAdminTenantRow(tenant)).toMatchObject({ id: "tenant-1", monthlyBudgetUsd: "100.00000000" });
    expect(mapAdminAlertRow(alert)).toMatchObject({ id: "alert-1", status: "open", target: "tenant-1" });
    expect(mapAdminSloRow(slo)).toMatchObject({ id: "availability", status: "violated" });
    expect(mapAdminCostUsageRow(cost)).toEqual({
      costUsd: "1.25000000",
      model: "provider/model",
      tenantId: "tenant-1"
    });
    expect(mapAdminAuditRow(audit)).toMatchObject({
      action: "UPDATE",
      actor: "admin-1",
      id: "admin-audit-1",
      resourceId: "stage-1"
    });
    expect(mapMetricAuditTrailRow(metric)).toMatchObject({
      id: "metric-event-1",
      kind: "eval-result",
      payload: { pass: true },
      tenantId: "tenant-1"
    });
  });
});

function sequentialIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
