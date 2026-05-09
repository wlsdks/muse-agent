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
  buildCheckpointUpsertQuery,
  createHookTraceInsert,
  mapCheckpointRow,
  mapHookTraceRow
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
