import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { migrations, type MuseDatabase } from "@muse/db";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KyselyTokenCostQuery, KyselyTokenUsageSink } from "../src/index.js";

const runPostgres = process.env.MUSE_DB_POSTGRES_TEST === "1";

describe.skipIf(!runPostgres)("KyselyTokenCostQuery deterministic tiebreak (Postgres)", () => {
  let container: StartedTestContainer;
  let db: Kysely<MuseDatabase>;

  beforeAll(async () => {
    configureDockerRuntimeForLocalDesktop();
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({ POSTGRES_DB: "muse", POSTGRES_PASSWORD: "muse", POSTGRES_USER: "muse" })
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

  it("daily breaks same-day same-cost ties by model ASC (Qwen-only $0 rows don't shuffle across reloads)", async () => {
    const sink = new KyselyTokenUsageSink(db);
    const day = new Date("2026-05-20T10:00:00.000Z");
    // Insert in REVERSE of the desired order so a missing tiebreak surfaces.
    await sink.record({ completionTokens: 1, estimatedCostUsd: 0, model: "zeta", promptTokens: 1, provider: "ollama", runId: "r1", totalTokens: 2, recordedAt: day });
    await sink.record({ completionTokens: 1, estimatedCostUsd: 0, model: "alpha", promptTokens: 1, provider: "ollama", runId: "r2", totalTokens: 2, recordedAt: day });

    const rows = await new KyselyTokenCostQuery(db).daily({
      from: new Date("2026-05-20T00:00:00.000Z"),
      to: new Date("2026-05-21T00:00:00.000Z")
    });
    expect(rows.map((r) => r.model)).toEqual(["alpha", "zeta"]);
  });

  it("topExpensive breaks cost+token ties by runId ASC", async () => {
    const sink = new KyselyTokenUsageSink(db);
    const at = new Date("2026-05-22T10:00:00.000Z");
    await sink.record({ completionTokens: 5, estimatedCostUsd: 0, model: "qwen", promptTokens: 5, provider: "ollama", runId: "run-zzz", totalTokens: 10, recordedAt: at });
    await sink.record({ completionTokens: 5, estimatedCostUsd: 0, model: "qwen", promptTokens: 5, provider: "ollama", runId: "run-aaa", totalTokens: 10, recordedAt: at });

    const rows = await new KyselyTokenCostQuery(db).topExpensive({
      from: new Date("2026-05-22T00:00:00.000Z"),
      to: new Date("2026-05-23T00:00:00.000Z"),
      limit: 10
    });
    const ties = rows.filter((r) => r.runId === "run-aaa" || r.runId === "run-zzz").map((r) => r.runId);
    expect(ties).toEqual(["run-aaa", "run-zzz"]);
  });
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
