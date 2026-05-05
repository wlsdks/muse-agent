import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import { describe, expect, it } from "vitest";

import {
  buildApprovalDecisionQuery,
  buildCheckpointUpsertQuery,
  buildPendingApprovalsQuery,
  createHookTraceInsert,
  createPendingApprovalInsert,
  mapApprovalResponse,
  mapCheckpointRow,
  mapHookTraceRow,
  mapPendingApprovalRow
} from "../src/kysely-stores.js";

describe("Kysely runtime state stores", () => {
  it("builds PostgreSQL checkpoint upsert SQL with the run and step uniqueness contract", () => {
    const db = createPostgresBuilder();
    const query = buildCheckpointUpsertQuery(
      db,
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        runId: "run-1",
        state: { phase: "tool" },
        step: 2
      },
      { idFactory: () => "checkpoint-1", now: () => new Date("2026-01-02T00:00:00.000Z") }
    );

    const compiled = query.compile();

    expect(compiled.sql).toContain('insert into "checkpoints"');
    expect(compiled.sql).toContain('on conflict ("run_id", "step") do update');
    expect(compiled.sql).toContain("returning *");
    expect(compiled.parameters).toEqual([
      new Date("2026-01-01T00:00:00.000Z"),
      "checkpoint-1",
      "run-1",
      { phase: "tool" },
      2,
      new Date("2026-01-01T00:00:00.000Z"),
      "checkpoint-1",
      { phase: "tool" }
    ]);
  });

  it("builds PostgreSQL pending approval queries for operator work queues", () => {
    const db = createPostgresBuilder();
    const list = buildPendingApprovalsQuery(db, "user-1").compile();
    const decision = buildApprovalDecisionQuery(db, "approval-1", "approved", {
      modifiedArguments: { limit: 5 },
      now: () => new Date("2026-01-01T00:00:00.000Z")
    }).compile();

    expect(list.sql).toContain('from "pending_approvals"');
    expect(list.sql).toContain('where "status" = $1 and "user_id" = $2');
    expect(list.sql).toContain('order by "requested_at" desc');
    expect(list.parameters).toEqual(["pending", "user-1"]);

    expect(decision.sql).toContain('update "pending_approvals"');
    expect(decision.sql).toContain('where "id" = $5 and "status" = $6');
    expect(decision.sql).toContain("returning *");
    expect(decision.parameters).toEqual([
      { limit: 5 },
      null,
      new Date("2026-01-01T00:00:00.000Z"),
      "approved",
      "approval-1",
      "pending"
    ]);
  });

  it("maps PostgreSQL rows back to runtime state value objects", () => {
    expect(
      mapCheckpointRow({
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        id: "checkpoint-1",
        run_id: "run-1",
        state: { value: "saved" },
        step: 4
      })
    ).toEqual({
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "checkpoint-1",
      runId: "run-1",
      state: { value: "saved" },
      step: 4
    });

    expect(
      mapPendingApprovalRow({
        arguments: { amount: 10 },
        context: {
          action: "create_record",
          impactScope: "workspace",
          reason: "requires approval",
          reversibility: "partially_reversible"
        },
        id: "approval-1",
        modified_arguments: {},
        reason: null,
        requested_at: new Date("2026-01-01T00:00:00.000Z"),
        resolved_at: null,
        run_id: "run-1",
        status: "pending",
        timeout_ms: 30_000,
        tool_name: "create_record",
        user_id: "user-1"
      })
    ).toMatchObject({
      context: {
        action: "create_record",
        impactScope: "workspace",
        reason: "requires approval",
        reversibility: "partially_reversible"
      },
      id: "approval-1",
      status: "pending",
      timeoutMs: 30_000
    });
  });

  it("creates pending approval rows with bounded timeouts and maps approved responses", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const row = createPendingApprovalInsert(
      {
        arguments: { path: "docs/plan.md" },
        runId: "run-1",
        timeoutMs: 0,
        toolName: "write_file",
        userId: "user-1"
      },
      { defaultTimeoutMs: 45_000, idFactory: () => "approval-1", now: () => now }
    );

    expect(row).toMatchObject({
      id: "approval-1",
      requested_at: now,
      status: "pending",
      timeout_ms: 45_000
    });
    expect(
      mapApprovalResponse({
        ...row,
        modified_arguments: { path: "docs/final.md" },
        reason: null,
        resolved_at: now,
        status: "approved"
      })
    ).toEqual({
      approved: true,
      modifiedArguments: { path: "docs/final.md" }
    });
  });

  it("creates and maps hook trace rows for persisted hook observability", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const completedAt = new Date("2026-01-01T00:00:00.025Z");
    const row = createHookTraceInsert(
      {
        completedAt,
        error: "hook failed",
        hookId: "audit",
        lifecycle: "afterComplete",
        metadata: { tenantId: "tenant-1" },
        runId: "run-1",
        startedAt: now,
        status: "failed"
      },
      { idFactory: () => "hook-trace-1", now: () => now }
    );

    expect(row).toMatchObject({
      duration_ms: 25,
      error: "hook failed",
      hook_id: "audit",
      id: "hook-trace-1",
      lifecycle: "afterComplete",
      status: "failed"
    });
    expect(mapHookTraceRow(row)).toMatchObject({
      durationMs: 25,
      error: "hook failed",
      hookId: "audit",
      metadata: { tenantId: "tenant-1" },
      runId: "run-1"
    });
  });
});

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}
