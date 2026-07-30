import { expect, it } from "vitest";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createMagAdminReadOnlyInspector,
  readMagAdminReadonlyInspectorFailure
} from "./mag-admin-readonly-inspector.mjs";
import { MagAdminReadonlyError } from "./mag-admin-readonly-spine.js";
import { openSqliteMagStore } from "./mag-sqlite-store.js";
import {
  MAG_PHYSICAL_SCHEMA_V1,
  classifyMagPhysicalSchemaV1
} from "./mag-physical-schema-v1.mjs";

it("defines and classifies the exact MAG v1 physical profile", () => {
  expect(MAG_PHYSICAL_SCHEMA_V1).toMatchObject({
    applicationId: 0x4d414731,
    userVersion: 1,
    maxProjectionBytes: 1_048_576
  });
  expect(Object.isFrozen(MAG_PHYSICAL_SCHEMA_V1)).toBe(true);
  const match = classifyMagPhysicalSchemaV1({
    applicationId: MAG_PHYSICAL_SCHEMA_V1.applicationId,
    userVersion: MAG_PHYSICAL_SCHEMA_V1.userVersion,
    objects: MAG_PHYSICAL_SCHEMA_V1.objects,
    headForeignKey: MAG_PHYSICAL_SCHEMA_V1.headForeignKey
  });
  expect(match).toEqual({ kind: "match" });
  expect(Object.isFrozen(match)).toBe(true);
  expect(classifyMagPhysicalSchemaV1({
    applicationId: MAG_PHYSICAL_SCHEMA_V1.applicationId,
    userVersion: 2,
    objects: MAG_PHYSICAL_SCHEMA_V1.objects,
    headForeignKey: MAG_PHYSICAL_SCHEMA_V1.headForeignKey
  })).toEqual({ kind: "future" });
  expect(classifyMagPhysicalSchemaV1({
    applicationId: 1,
    userVersion: 2,
    objects: MAG_PHYSICAL_SCHEMA_V1.objects,
    headForeignKey: MAG_PHYSICAL_SCHEMA_V1.headForeignKey
  })).toEqual({ kind: "foreign-or-corrupt" });
  expect(classifyMagPhysicalSchemaV1({
    applicationId: MAG_PHYSICAL_SCHEMA_V1.applicationId,
    userVersion: 1,
    objects: [
      ...MAG_PHYSICAL_SCHEMA_V1.objects,
      MAG_PHYSICAL_SCHEMA_V1.objects[0]!
    ],
    headForeignKey: MAG_PHYSICAL_SCHEMA_V1.headForeignKey
  })).toEqual({ kind: "foreign-or-corrupt" });
  expect(classifyMagPhysicalSchemaV1({
    applicationId: MAG_PHYSICAL_SCHEMA_V1.applicationId,
    userVersion: 1,
    objects: MAG_PHYSICAL_SCHEMA_V1.objects,
    headForeignKey: MAG_PHYSICAL_SCHEMA_V1.headForeignKey.map((row, index) =>
      index === 0 ? Object.freeze({ ...row, seq: 9 }) : row
    )
  })).toEqual({ kind: "foreign-or-corrupt" });
});

it("preserves FUTURE_STORE_STATE when serving sees a future version and wrong application ID", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "muse-mag-combined-identity-"))
  );
  const databasePath = join(directory, "combined.sqlite");
  try {
    const database = new DatabaseSync(databasePath, { readBigInts: true });
    database.exec(`
      ${MAG_PHYSICAL_SCHEMA_V1.createJournal};
      ${MAG_PHYSICAL_SCHEMA_V1.createGenerationIndex};
      ${MAG_PHYSICAL_SCHEMA_V1.createHead};
      PRAGMA application_id = 1;
      PRAGMA user_version = 2;
    `);
    database.close();
    await chmod(databasePath, 0o600);

    await expect(openSqliteMagStore({ databasePath })).rejects.toMatchObject({
      code: "FUTURE_STORE_STATE"
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("inspects an empty caller-owned MAG v1 snapshot without closing it", () => {
  const database = new DatabaseSync(":memory:", { readBigInts: true });
  database.exec(`
    ${MAG_PHYSICAL_SCHEMA_V1.createJournal};
    ${MAG_PHYSICAL_SCHEMA_V1.createGenerationIndex};
    ${MAG_PHYSICAL_SCHEMA_V1.createHead};
    PRAGMA application_id = ${MAG_PHYSICAL_SCHEMA_V1.applicationId};
    PRAGMA user_version = ${MAG_PHYSICAL_SCHEMA_V1.userVersion};
  `);

  const inspector = createMagAdminReadOnlyInspector(database);
  expect(inspector.inspectSummary()).toEqual({
    applicationId: 0x4d414731,
    userVersion: 1,
    protocolVersion: 1,
    sqliteVersion: expect.any(String),
    headRows: 0,
    journalRows: 0,
    maxGeneration: 0
  });
  expect(inspector.inspectHead({
    sourceId: "source",
    threadId: "thread"
  })).toEqual({ found: false });
  expect(inspector.verifyIntegrity()).toEqual({ verified: true });
  expect(database.prepare("SELECT 1 AS value").get()).toMatchObject({ value: 1n });
  database.close();
});

function createFixtureDatabase() {
  const database = new DatabaseSync(":memory:", { readBigInts: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    ${MAG_PHYSICAL_SCHEMA_V1.createJournal};
    ${MAG_PHYSICAL_SCHEMA_V1.createGenerationIndex};
    ${MAG_PHYSICAL_SCHEMA_V1.createHead};
    PRAGMA application_id = ${MAG_PHYSICAL_SCHEMA_V1.applicationId};
    PRAGMA user_version = ${MAG_PHYSICAL_SCHEMA_V1.userVersion};
  `);
  return database;
}

function insertHead(
  database: DatabaseSync,
  sourceId: string,
  threadId: string,
  generation: bigint,
  commitId: string,
  fingerprint: string
) {
  database.prepare(`
    INSERT INTO mag_projection_journal (
      source_id, thread_id, generation, commit_id,
      projection_json, projection_fingerprint
    ) VALUES (?, ?, ?, ?, '{}', ?)
  `).run(sourceId, threadId, generation, commitId, fingerprint);
  database.prepare(`
    INSERT INTO mag_projection_head (
      source_id, thread_id, generation, commit_id
    ) VALUES (?, ?, ?, ?)
  `).run(sourceId, threadId, generation, commitId);
}

it("returns detached summary and exact found or missing heads for distinct scopes", () => {
  const database = createFixtureDatabase();
  insertHead(database, "자료", "é", 1n, "commit-a", "fingerprint-a");
  insertHead(database, "자료", "e\u0301", 3n, "commit-b", "fingerprint-b");
  const inspector = createMagAdminReadOnlyInspector(database);

  expect(inspector.inspectSummary()).toMatchObject({
    headRows: 2,
    journalRows: 2,
    maxGeneration: 3
  });
  const found = inspector.inspectHead({ sourceId: "자료", threadId: "e\u0301" });
  expect(found).toEqual({
    found: true,
    head: {
      scope: { sourceId: "자료", threadId: "e\u0301" },
      generation: 3,
      commitId: "commit-b",
      projectionFingerprint: "fingerprint-b"
    }
  });
  expect(Object.isFrozen(found)).toBe(true);
  if (!found.found) throw new Error("expected an exact head");
  expect(Object.isFrozen(found.head)).toBe(true);
  expect(Object.isFrozen(found.head.scope)).toBe(true);
  expect(inspector.inspectHead({
    sourceId: "자료",
    threadId: "missing"
  })).toEqual({ found: false });
  database.close();
});

it("distinguishes a dangling head from a missing scope", () => {
  const database = createFixtureDatabase();
  insertHead(database, "source", "thread", 1n, "commit", "fingerprint");
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("DELETE FROM mag_projection_journal");
  const inspector = createMagAdminReadOnlyInspector(database);

  let failure: unknown;
  try {
    inspector.inspectHead({ sourceId: "source", threadId: "thread" });
  } catch (cause) {
    failure = cause;
  }
  expect(readMagAdminReadonlyInspectorFailure(failure)).toBe("CORRUPT_STORE");
  expect(inspector.inspectHead({
    sourceId: "source",
    threadId: "missing"
  })).toEqual({ found: false });
  expect(() => inspector.verifyIntegrity()).toThrow();
  database.close();
});

it("authenticates only same-module sanitized inspector failures", () => {
  const future = createFixtureDatabase();
  future.exec("PRAGMA user_version = 2");
  let failure: unknown;
  try {
    createMagAdminReadOnlyInspector(future);
  } catch (cause) {
    failure = cause;
  }
  expect(readMagAdminReadonlyInspectorFailure(failure)).toBe(
    "FUTURE_STORE_STATE"
  );
  expect(failure).toMatchObject({
    name: "MagAdminReadonlyInspectorFailure",
    message: "Admin store version is unsupported",
    stack: "MagAdminReadonlyInspectorFailure: Admin store version is unsupported"
  });
  expect(Object.isFrozen(failure)).toBe(true);
  expect(readMagAdminReadonlyInspectorFailure({
    name: "MagAdminReadonlyInspectorFailure",
    code: "FUTURE_STORE_STATE"
  })).toBeUndefined();
  expect(readMagAdminReadonlyInspectorFailure(
    new MagAdminReadonlyError("CORRUPT_STORE")
  )).toBeUndefined();
  future.close();
});

function fakeMetadataDatabase(
  schemaRows: unknown,
  suppliedForeignKeys?: unknown
) {
  const preparedSql: string[] = [];
  const foreignKeys = MAG_PHYSICAL_SCHEMA_V1.headForeignKey.map((row) => ({
    ...row,
    id: BigInt(row.id),
    seq: BigInt(row.seq)
  }));
  return {
    preparedSql,
    exec() {},
    prepare(sql: string) {
      preparedSql.push(sql);
      return {
        all() {
          if (sql.includes("sqlite_schema")) return schemaRows;
          if (sql.includes("pragma_foreign_key_list")) {
            return suppliedForeignKeys ?? foreignKeys;
          }
          return [];
        },
        get() {
          if (sql.includes("application_id")) {
            return { application_id: BigInt(MAG_PHYSICAL_SCHEMA_V1.applicationId) };
          }
          if (sql.includes("user_version")) return { user_version: 1n };
          if (sql.includes("query_only")) return { query_only: 1n };
          if (sql.includes("trusted_schema")) return { trusted_schema: 0n };
          if (sql.includes("foreign_keys")) return { foreign_keys: 1n };
          if (sql.includes("sqlite_version")) return { sqliteVersion: "3.50.4" };
          return undefined;
        }
      };
    }
  };
}

function manifestSchemaRows() {
  return MAG_PHYSICAL_SCHEMA_V1.objects.map((row) => ({
    type: row.type,
    name: row.name,
    tableName: row.tableName,
    sql: row.normalizedSql
  }));
}

it("rejects hostile and sentinel metadata before invoking hidden code", () => {
  let calls = 0;
  const proxy = new Proxy([], {
    getPrototypeOf() {
      calls += 1;
      return Array.prototype;
    },
    ownKeys() {
      calls += 1;
      return [];
    }
  });
  for (const rows of [
    proxy,
    [...manifestSchemaRows(), manifestSchemaRows()[0]],
    manifestSchemaRows().map((row, index) => index === 0
      ? { ...row, sql: "x".repeat(4_097) }
      : row)
  ]) {
    let failure: unknown;
    try {
      createMagAdminReadOnlyInspector(fakeMetadataDatabase(rows));
    } catch (cause) {
      failure = cause;
    }
    expect(readMagAdminReadonlyInspectorFailure(failure)).toBe("CORRUPT_STORE");
  }
  const oversizedForeignKeys = MAG_PHYSICAL_SCHEMA_V1.headForeignKey.map(
    (row, index) => ({
      ...row,
      id: BigInt(row.id),
      seq: BigInt(row.seq),
      from: index === 0 ? "x".repeat(513) : row.from
    })
  );
  const sentinelForeignKeys = [
    ...oversizedForeignKeys.map((row, index) => ({
      ...row,
      from: MAG_PHYSICAL_SCHEMA_V1.headForeignKey[index]?.from ?? row.from
    })),
    oversizedForeignKeys[0]
  ];
  for (const rows of [oversizedForeignKeys, sentinelForeignKeys]) {
    let failure: unknown;
    try {
      createMagAdminReadOnlyInspector(
        fakeMetadataDatabase(manifestSchemaRows(), rows)
      );
    } catch (cause) {
      failure = cause;
    }
    expect(readMagAdminReadonlyInspectorFailure(failure)).toBe("CORRUPT_STORE");
  }
  expect(calls).toBe(0);
});

it("uses bounded metadata SQL and maps only numeric SQLite primary codes", () => {
  const database = fakeMetadataDatabase(manifestSchemaRows());
  createMagAdminReadOnlyInspector(database);
  expect(database.preparedSql.some((sql) =>
    sql.includes("sqlite_schema") && sql.includes("LIMIT 4")
  )).toBe(true);
  expect(database.preparedSql.some((sql) =>
    sql.includes("pragma_foreign_key_list") && sql.includes("LIMIT 5")
  )).toBe(true);
  expect(database.preparedSql.join("\n")).not.toContain("projection_json");
  expect(database.preparedSql.join("\n")).not.toContain("assertion");
  expect(database.preparedSql.join("\n")).not.toContain("evidence");

  for (const [errcode, expected] of [
    [5, "STORE_BUSY"],
    [6, "STORE_BUSY"],
    [11, "CORRUPT_STORE"],
    [26, "CORRUPT_STORE"],
    [1, "WORKER_FAILURE"]
  ] as const) {
    const error = new Error("private SQLite detail") as Error & { errcode: number };
    error.errcode = errcode;
    let failure: unknown;
    try {
      createMagAdminReadOnlyInspector({
        exec() {
          throw error;
        },
        prepare() {
          throw new Error("unreachable");
        }
      });
    } catch (cause) {
      failure = cause;
    }
    expect(readMagAdminReadonlyInspectorFailure(failure)).toBe(expected);
    expect(String(failure)).not.toContain("private SQLite detail");
  }
});
