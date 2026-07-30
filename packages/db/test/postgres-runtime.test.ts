import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Kysely, PostgresDialect, sql } from "kysely";
import { migrations, type MuseDatabase } from "../src/index.js";

const runPostgresSmoke = process.env.MUSE_DB_POSTGRES_TEST === "1";

describe.skipIf(!runPostgresSmoke)("PostgreSQL runtime migrations", () => {
  let container: StartedTestContainer;
  let db: Kysely<MuseDatabase>;

  beforeAll(async () => {
    configureDockerRuntimeForLocalDesktop();

    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "muse",
        POSTGRES_PASSWORD: "muse",
        POSTGRES_USER: "muse"
      })
      .withExposedPorts(5432)
      .start();

    db = new Kysely<MuseDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          database: "muse",
          host: container.getHost(),
          password: "muse",
          port: container.getMappedPort(5432),
          user: "muse"
        })
      })
    });

    for (const migration of migrations) {
      await sql.raw(migration.up).execute(db);
    }
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await container?.stop();
  }, 30_000);

  it("applies consolidated migrations and reads/writes representative runtime tables", async () => {
    await expect(tableExists("agent_runs")).resolves.toBe(true);
    await expect(tableExists("conversation_messages")).resolves.toBe(true);
    await expect(tableExists("trace_events")).resolves.toBe(true);
    await expect(tableExists("runtime_settings")).resolves.toBe(true);
    await expect(tableExists("users")).resolves.toBe(true);
    await expect(tableExists("user_memories")).resolves.toBe(true);
    await expect(tableExists("metric_token_usage")).resolves.toBe(true);

    await db.insertInto("runtime_settings").values({
      category: "runtime",
      description: "PostgreSQL smoke setting",
      key: "postgres_smoke",
      type: "string",
      updated_by: "postgres-runtime-test",
      value: JSON.stringify("ok")
    }).execute();

    await db.insertInto("agent_runs").values({
      id: "run-postgres-smoke",
      input: "PostgreSQL migration smoke",
      mode: "react",
      model: "diagnostic/smoke",
      provider: "diagnostic",
      status: "completed"
    }).execute();

    const setting = await db.selectFrom("runtime_settings")
      .select(["key", "value"])
      .where("key", "=", "postgres_smoke")
      .executeTakeFirstOrThrow();
    const run = await db.selectFrom("agent_runs")
      .select(["id", "status"])
      .where("id", "=", "run-postgres-smoke")
      .executeTakeFirstOrThrow();

    expect(setting).toEqual({
      key: "postgres_smoke",
      value: JSON.stringify("ok")
    });
    expect(run).toEqual({
      id: "run-postgres-smoke",
      status: "completed"
    });

    await sql`
      INSERT INTO scheduled_jobs (
        id,
        name,
        cron_expression,
        timezone,
        job_type,
        tool_arguments,
        tags
      ) VALUES (
        'job-trigger-correlation',
        'Trigger correlation',
        '0 * * * * *',
        'UTC',
        'agent',
        '{}'::jsonb,
        '[]'::jsonb
      )
    `.execute(db);
    const triggerDedupKey = `trigger:${"a".repeat(64)}`;
    await db.insertInto("scheduled_job_executions").values({
      completed_at: new Date("2026-07-31T00:00:01.000Z"),
      dry_run: false,
      duration_ms: 1_000,
      id: "execution-trigger-correlation",
      job_id: "job-trigger-correlation",
      job_name: "Trigger correlation",
      payload_preview: null,
      result: "ok",
      started_at: new Date("2026-07-31T00:00:00.000Z"),
      status: "success",
      trigger_dedup_key: triggerDedupKey,
      triggered_by: null
    }).execute();
    const correlated = await db.selectFrom("scheduled_job_executions")
      .select(["id", "trigger_dedup_key"])
      .where("trigger_dedup_key", "=", triggerDedupKey)
      .executeTakeFirstOrThrow();
    expect(correlated).toEqual({
      id: "execution-trigger-correlation",
      trigger_dedup_key: triggerDedupKey
    });
    await expect(db.insertInto("scheduled_job_executions").values({
      completed_at: new Date("2026-07-31T00:00:02.000Z"),
      dry_run: false,
      duration_ms: 1_000,
      id: "execution-trigger-correlation-duplicate",
      job_id: "job-trigger-correlation",
      job_name: "Trigger correlation",
      payload_preview: null,
      result: "duplicate",
      started_at: new Date("2026-07-31T00:00:01.000Z"),
      status: "success",
      trigger_dedup_key: triggerDedupKey,
      triggered_by: null
    }).execute()).rejects.toThrow();
  }, 120_000);

  async function tableExists(tableName: string): Promise<boolean> {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ${tableName}
      ) AS "exists"
    `.execute(db);

    return result.rows[0]?.exists === true;
  }
});

function configureDockerRuntimeForLocalDesktop(): void {
  const rancherDesktopSocket = path.join(homedir(), ".rd/docker.sock");

  if (!process.env.DOCKER_HOST && existsSync(rancherDesktopSocket)) {
    process.env.DOCKER_HOST = `unix://${rancherDesktopSocket}`;
  }

  if (process.env.DOCKER_HOST?.includes(".rd/docker.sock") && !process.env.TESTCONTAINERS_RYUK_DISABLED) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = "true";
  }
}
