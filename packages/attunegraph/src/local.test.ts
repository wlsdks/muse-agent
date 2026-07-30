import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

import { afterEach, expect, it } from "vitest";

import { createInMemoryAttuneGraphStore } from "./attunegraph-in-memory-store.js";
import { createAttuneGraphStore } from "./attunegraph-backend.js";
import type { AttuneGraphProjectCommand, AttuneGraphScope } from "./attunegraph-contracts.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import { openLocalAttuneGraph } from "./local.js";
import { openSqliteAttuneGraphStore } from "./attunegraph-sqlite-store.js";
import { runAttuneGraphStoreConformance } from "./attunegraph-testing.js";

const NOW = "2026-07-30T00:00:00.000Z";
const SCOPE: AttuneGraphScope = {
  sourceId: "local-source",
  threadId: "local-thread"
};
const temporaryDirectories: string[] = [];

async function temporaryDatabase(name = "attunegraph.sqlite"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-local-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return join(canonicalDirectory, name);
}

function command(
  key: string,
  scope: AttuneGraphScope = SCOPE
): AttuneGraphProjectCommand {
  return {
    operator: "canonical-projection@1",
    observation: {
      schemaVersion: 1,
      observationKey: key,
      scope,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [{
        schemaVersion: 1,
        id: `assertion-${key}`,
        subject: { id: `artifact-${key}`, kind: "artifact" },
        predicate: "LINKED_TO",
        object: { id: scope.threadId, kind: "thread" },
        epistemicClass: "source-observed",
        sourceRefs: [{ id: `source-ref-${key}`, namespace: "example.local-test" }],
        recordedAt: NOW,
        derivation: { kind: "projection", version: "local-test@1" }
      }]
    }
  };
}

function execute(scope: AttuneGraphScope = SCOPE) {
  return {
    operator: "working-graph@1" as const,
    seed: { id: scope.threadId, kind: "thread" as const },
    now: NOW,
    maxEstimatedTokens: 256
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

it("rejects hostile options before creating a database", async () => {
  const databasePath = await temporaryDatabase();
  const options = { databasePath, scope: SCOPE };

  await expect(
    openLocalAttuneGraph(new Proxy(options, {}))
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "databasePath", {
    enumerable: true,
    get: () => databasePath
  });
  Object.defineProperty(accessor, "scope", {
    enumerable: true,
    value: SCOPE
  });
  await expect(openLocalAttuneGraph(accessor as never)).rejects.toMatchObject({
    code: "INVALID_INPUT"
  });
  await expect(lstat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("persists and reopens byte-identical Engine snapshots and results", async () => {
  const databasePath = await temporaryDatabase();
  const local = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const memory = await openAttuneGraph({
    scope: SCOPE,
    store: createInMemoryAttuneGraphStore()
  });
  const input = command("restart");

  const [localSnapshot, memorySnapshot] = await Promise.all([
    local.project(input),
    memory.project(input)
  ]);
  await expect(local.head()).resolves.toEqual(localSnapshot);
  await expect(memory.head()).resolves.toEqual(memorySnapshot);
  const [localResult, memoryResult] = await Promise.all([
    local.execute(execute()),
    memory.execute(execute())
  ]);
  expect(JSON.stringify(localSnapshot)).toBe(JSON.stringify(memorySnapshot));
  expect(JSON.stringify(localResult)).toBe(JSON.stringify(memoryResult));
  await Promise.all([local.close(), memory.close()]);

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.head()).resolves.toEqual(localSnapshot);
  expect(JSON.stringify(await reopened.project(input))).toBe(
    JSON.stringify(localSnapshot)
  );
  expect(JSON.stringify(await reopened.execute(execute()))).toBe(
    JSON.stringify(localResult)
  );
  await reopened.close();
  await reopened.close();
  await expect(reopened.head()).rejects.toMatchObject({ code: "CLOSED" });
  await expect(reopened.project(input)).rejects.toMatchObject({ code: "CLOSED" });
  await expect(reopened.execute(execute())).rejects.toMatchObject({ code: "CLOSED" });
});

function inspectDatabaseWithoutMutation(databasePath: string): {
  readonly pragmas: Readonly<Record<string, unknown>>;
  readonly schema: readonly unknown[];
  readonly tables: Readonly<Record<string, readonly unknown[]>>;
} {
  const database = new DatabaseSync(databasePath, {
    readBigInts: true,
    readOnly: true
  });
  try {
    const schema = database.prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const tables: Record<string, readonly unknown[]> = {};
    for (const row of schema) {
      if (row.type !== "table" || typeof row.name !== "string") continue;
      if (!/^[a-z0-9_]+$/u.test(row.name)) throw new Error("fixture table name is unsafe");
      tables[row.name] = database.prepare(
        `SELECT * FROM "${row.name}"`
      ).all();
    }
    return {
      pragmas: {
        applicationId: database.prepare("PRAGMA application_id").get(),
        journalMode: database.prepare("PRAGMA journal_mode").get(),
        userVersion: database.prepare("PRAGMA user_version").get()
      },
      schema,
      tables
    };
  } finally {
    database.close();
  }
}

async function inspectDatabaseBytes(bytes: Uint8Array): Promise<
  ReturnType<typeof inspectDatabaseWithoutMutation>
> {
  const inspectionPath = await temporaryDatabase("inspection.sqlite");
  await writeFile(inspectionPath, bytes, { mode: 0o600 });
  return inspectDatabaseWithoutMutation(inspectionPath);
}

it("rejects the superseded numeric physical identity before mutation", async () => {
  const databasePath = await temporaryDatabase("incompatible.sqlite");
  const encoded = await readFile(
    new URL("./fixtures/attunegraph-legacy-sqlite-v1.base64", import.meta.url),
    "utf8"
  );
  const fixture = gunzipSync(Buffer.from(encoded.trim(), "base64"));
  expect(createHash("sha256").update(fixture).digest("hex")).toBe(
    "0b44d5cf634fbbed3c38125613250727739bb4e014a2846bc0d343521da63504"
  );
  await writeFile(databasePath, fixture, { mode: 0o600 });
  const beforeBytes = await readFile(databasePath);
  const beforeDirectory = await readdir(dirname(databasePath));
  const beforeDatabase = await inspectDatabaseBytes(beforeBytes);
  expect(beforeDatabase.pragmas.applicationId).toEqual({
    application_id: 0x4d414731n
  });

  await expect(openLocalAttuneGraph({
    databasePath,
    scope: { sourceId: "incompatible-source", threadId: "incompatible-thread" }
  })).rejects.toMatchObject({ code: "INCOMPATIBLE_STORE_PROFILE" });

  const afterBytes = await readFile(databasePath);
  expect(afterBytes).toEqual(beforeBytes);
  expect(await readdir(dirname(databasePath))).toEqual(beforeDirectory);
  expect(await inspectDatabaseBytes(afterBytes)).toEqual(beforeDatabase);
  for (const suffix of ["-wal", "-shm"]) {
    await expect(lstat(`${databasePath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("linearizes two independent Worker connections on one file", async () => {
  const databasePath = await temporaryDatabase();
  const first = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const second = await openLocalAttuneGraph({ databasePath, scope: SCOPE });

  const different = await Promise.allSettled([
    first.project(command("race-a")),
    second.project(command("race-b"))
  ]);
  expect(different.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    different.filter(
      (result) =>
        result.status === "rejected"
        && (result.reason as { code?: unknown }).code === "SNAPSHOT_CONFLICT"
    )
  ).toHaveLength(1);
  await Promise.all([first.close(), second.close()]);

  const identicalPath = await temporaryDatabase("identical.sqlite");
  const left = await openLocalAttuneGraph({ databasePath: identicalPath, scope: SCOPE });
  const right = await openLocalAttuneGraph({ databasePath: identicalPath, scope: SCOPE });
  const same = command("same-race");
  const [leftSnapshot, rightSnapshot] = await Promise.all([
    left.project(same),
    right.project(same)
  ]);
  expect(leftSnapshot).toEqual(rightSnapshot);
  expect(leftSnapshot.generation).toBe(1);
  await Promise.all([left.close(), right.close()]);
});

it("uses owner-only files and rejects a symlink database target", async () => {
  const databasePath = await temporaryDatabase();
  const attuneGraph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await attuneGraph.project(command("permissions"));

  const databaseMode = (await lstat(databasePath)).mode & 0o777;
  expect(databaseMode).toBe(0o600);
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    const mode = (await lstat(sidecar)).mode & 0o777;
    expect(mode).toBe(0o600);
  }
  await attuneGraph.close();

  const symlinkPath = join(
    databasePath.slice(0, databasePath.lastIndexOf("/")),
    "linked.sqlite"
  );
  await symlink(databasePath, symlinkPath);
  await expect(
    openLocalAttuneGraph({ databasePath: symlinkPath, scope: SCOPE })
  ).rejects.toMatchObject({
    code: expect.stringMatching(/^(INVALID_INPUT|UNSUPPORTED_STORE_PROFILE)$/u)
  });

  const realDirectory = await realpath(join(databasePath, ".."));
  const linkedDirectory = join(realDirectory, "linked-parent");
  const targetDirectory = join(realDirectory, "target-parent");
  await mkdir(targetDirectory, { mode: 0o700 });
  await symlink(targetDirectory, linkedDirectory);
  await expect(
    openLocalAttuneGraph({
      databasePath: join(linkedDirectory, "redirected.sqlite"),
      scope: SCOPE
    })
  ).rejects.toMatchObject({ code: "UNSUPPORTED_STORE_PROFILE" });
});

it("passes the backend-neutral Store conformance corpus with disposal", async () => {
  const report = await runAttuneGraphStoreConformance(async () =>
    openSqliteAttuneGraphStore({ databasePath: await temporaryDatabase() })
  );
  expect(report).toMatchObject({ passed: true });
  expect(report.cases).toHaveLength(5);
});

it("recovers the three commit and acknowledgement crash boundaries", async () => {
  const beforeCommitPath = await temporaryDatabase("before-commit.sqlite");
  const beforeCommitResource = await openSqliteAttuneGraphStore({
    databasePath: beforeCommitPath,
    testFault: "before-commit"
  });
  const beforeCommitAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(beforeCommitResource.backend)
  });
  await expect(
    beforeCommitAttuneGraph.project(command("before-commit"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await beforeCommitAttuneGraph.close();

  const beforeCommitReopen = await openLocalAttuneGraph({
    databasePath: beforeCommitPath,
    scope: SCOPE
  });
  const firstAfterRollback = await beforeCommitReopen.project(
    command("after-rollback")
  );
  expect(firstAfterRollback.generation).toBe(1);
  await beforeCommitReopen.close();

  const lostAckPath = await temporaryDatabase("lost-ack.sqlite");
  const lostAckResource = await openSqliteAttuneGraphStore({
    databasePath: lostAckPath,
    testFault: "after-commit-before-ack"
  });
  const lostAckAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(lostAckResource.backend)
  });
  const lostAckCommand = command("lost-ack");
  await expect(lostAckAttuneGraph.project(lostAckCommand)).rejects.toMatchObject({
    code: "STORE_FAILURE"
  });
  await lostAckAttuneGraph.close();

  const lostAckReopen = await openLocalAttuneGraph({
    databasePath: lostAckPath,
    scope: SCOPE
  });
  const recoveredLostAck = await lostAckReopen.project(lostAckCommand);
  expect(recoveredLostAck.generation).toBe(1);
  const nextAfterLostAck = await lostAckReopen.project({
    ...command("after-lost-ack"),
    expectedSnapshot: recoveredLostAck
  });
  expect(nextAfterLostAck.generation).toBe(2);
  await lostAckReopen.close();

  const acknowledgedPath = await temporaryDatabase("acknowledged.sqlite");
  const acknowledgedResource = await openSqliteAttuneGraphStore({
    databasePath: acknowledgedPath
  });
  const acknowledgedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(acknowledgedResource.backend)
  });
  const acknowledgedSnapshot = await acknowledgedAttuneGraph.project(
    command("acknowledged")
  );
  await acknowledgedResource.terminateForTesting();
  await expect(
    acknowledgedAttuneGraph.execute(execute())
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await acknowledgedAttuneGraph.close();

  const acknowledgedReopen = await openLocalAttuneGraph({
    databasePath: acknowledgedPath,
    scope: SCOPE
  });
  const recoveredAcknowledged = await acknowledgedReopen.execute(execute());
  expect(recoveredAcknowledged.snapshot).toEqual(acknowledgedSnapshot);
  await acknowledgedReopen.close();
});

it("fails closed for future, foreign, malformed, orphaned, and NOTADB state", async () => {
  const futurePath = await temporaryDatabase("future.sqlite");
  const future = await openSqliteAttuneGraphStore({
    databasePath: futurePath,
    testFixtureMode: true
  });
  await future.mutateForTesting("future-user-version");
  await future.close();
  await expect(
    openLocalAttuneGraph({ databasePath: futurePath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "FUTURE_STORE_STATE" });

  const foreignPath = await temporaryDatabase("foreign.sqlite");
  const foreign = await openSqliteAttuneGraphStore({
    databasePath: foreignPath,
    testFixtureMode: true
  });
  await foreign.mutateForTesting("wrong-application-id");
  await foreign.close();
  await expect(
    openLocalAttuneGraph({ databasePath: foreignPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const malformedPath = await temporaryDatabase("malformed.sqlite");
  const malformed = await openSqliteAttuneGraphStore({
    databasePath: malformedPath,
    testFixtureMode: true
  });
  const malformedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(malformed.backend)
  });
  await malformedAttuneGraph.project(command("malformed"));
  await malformed.mutateForTesting("malformed-projection-json");
  await malformedAttuneGraph.close();
  await malformed.close();
  const malformedReopen = await openLocalAttuneGraph({
    databasePath: malformedPath,
    scope: SCOPE
  });
  await expect(
    malformedReopen.execute(execute())
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  await malformedReopen.close();

  const orphanPath = await temporaryDatabase("orphan.sqlite");
  const orphan = await openSqliteAttuneGraphStore({
    databasePath: orphanPath,
    testFixtureMode: true
  });
  const orphanAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(orphan.backend)
  });
  await orphanAttuneGraph.project(command("orphan"));
  await orphan.mutateForTesting("missing-journal-row");
  await orphanAttuneGraph.close();
  await orphan.close();
  await expect(
    openLocalAttuneGraph({ databasePath: orphanPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const partialPath = await temporaryDatabase("partial-bootstrap.sqlite");
  const partial = await openSqliteAttuneGraphStore({
    databasePath: partialPath,
    testFixtureMode: true
  });
  await partial.mutateForTesting("partial-bootstrap");
  await partial.close();
  await expect(
    openLocalAttuneGraph({ databasePath: partialPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const oversizedPath = await temporaryDatabase("oversized.sqlite");
  const oversized = await openSqliteAttuneGraphStore({
    databasePath: oversizedPath,
    testFixtureMode: true
  });
  const oversizedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(oversized.backend)
  });
  await oversizedAttuneGraph.project(command("oversized"));
  await oversized.mutateForTesting("oversized-projection-json");
  await oversizedAttuneGraph.close();
  await oversized.close();
  await expect(
    openLocalAttuneGraph({ databasePath: oversizedPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const mismatchedPath = await temporaryDatabase("mismatched.sqlite");
  const mismatched = await openSqliteAttuneGraphStore({
    databasePath: mismatchedPath,
    testFixtureMode: true
  });
  const mismatchedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(mismatched.backend)
  });
  await mismatchedAttuneGraph.project(command("mismatched"));
  await mismatched.mutateForTesting("mismatched-head");
  await mismatchedAttuneGraph.close();
  await mismatched.close();
  await expect(
    openLocalAttuneGraph({ databasePath: mismatchedPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const quickCheckPath = await temporaryDatabase("quick-check.sqlite");
  const quickCheck = await openSqliteAttuneGraphStore({
    databasePath: quickCheckPath,
    testFixtureMode: true
  });
  await quickCheck.mutateForTesting("quick-check-corruption");
  try {
    await quickCheck.close();
  } catch (cause) {
    throw new Error("quick-check fixture close failed", { cause });
  }
  try {
    const unexpected = await openLocalAttuneGraph({
      databasePath: quickCheckPath,
      scope: SCOPE
    });
    await unexpected.close();
    throw new Error("quick-check corruption unexpectedly opened");
  } catch (cause) {
    expect(cause).toMatchObject({ code: "CORRUPT_STORE" });
  }

  const notDatabasePath = await temporaryDatabase("not-database.sqlite");
  await writeFile(notDatabasePath, "not a SQLite database", { mode: 0o600 });
  await expect(
    openLocalAttuneGraph({ databasePath: notDatabasePath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });
});

it("proves stale cross-Worker CAS, monotone generations, and exact physical counts", async () => {
  const databasePath = await temporaryDatabase("multi-generation.sqlite");
  const firstResource = await openSqliteAttuneGraphStore({
    databasePath,
    testFixtureMode: true
  });
  const secondResource = await openSqliteAttuneGraphStore({
    databasePath,
    testFixtureMode: true
  });
  const first = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(firstResource.backend)
  });
  const second = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(secondResource.backend)
  });

  const generationOne = await first.project(command("generation-one"));
  expect(await second.project(command("generation-one"))).toEqual(generationOne);
  const generationTwo = await first.project({
    ...command("generation-two"),
    expectedSnapshot: generationOne
  });
  await expect(second.project({
    ...command("stale-generation-two"),
    expectedSnapshot: generationOne
  })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });

  const generationThree = await Promise.allSettled([
    first.project({
      ...command("generation-three-a"),
      expectedSnapshot: generationTwo
    }),
    second.project({
      ...command("generation-three-b"),
      expectedSnapshot: generationTwo
    })
  ]);
  expect(generationThree.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    generationThree.filter(
      (result) =>
        result.status === "rejected"
        && (result.reason as { code?: unknown }).code === "SNAPSHOT_CONFLICT"
    )
  ).toHaveLength(1);
  expect(
    generationThree.find((result) => result.status === "fulfilled")?.value
  ).toMatchObject({ generation: 3 });
  expect(await firstResource.inspectForTesting()).toEqual({
    headRows: 1,
    journalRows: 3,
    maxGeneration: 3
  });

  await Promise.all([first.close(), second.close()]);
  await Promise.all([firstResource.close(), secondResource.close()]);
});

it("bounds busy exhaustion without an orphan journal or changed head", async () => {
  const databasePath = await temporaryDatabase("busy.sqlite");
  const holder = await openSqliteAttuneGraphStore({
    databasePath,
    testFixtureMode: true
  });
  const contender = await openSqliteAttuneGraphStore({
    databasePath,
    testFixtureMode: true
  });
  const contenderAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(contender.backend)
  });

  await holder.holdWriteLockForTesting(1_500);
  await expect(
    contenderAttuneGraph.project(command("busy-contender"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  expect(await holder.inspectForTesting()).toEqual({
    headRows: 0,
    journalRows: 0,
    maxGeneration: 0
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await contenderAttuneGraph.close();
  await Promise.all([holder.close(), contender.close()]);
});

it("awaits request and close timeout termination before the file can reopen", async () => {
  const lateReplyPath = await temporaryDatabase("late-reply.sqlite");
  const lateReply = await openSqliteAttuneGraphStore({
    databasePath: lateReplyPath,
    testResponseDelayMs: 75,
    testTimeoutMs: 50
  });
  const lateReplyAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(lateReply.backend)
  });
  await expect(
    lateReplyAttuneGraph.project(command("late-reply"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await lateReplyAttuneGraph.close();
  const afterLateReply = await openLocalAttuneGraph({
    databasePath: lateReplyPath,
    scope: SCOPE
  });
  await expect(
    afterLateReply.project(command("after-late-reply"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterLateReply.close();

  const readPath = await temporaryDatabase("read-timeout.sqlite");
  const hangingRead = await openSqliteAttuneGraphStore({
    databasePath: readPath,
    testFault: "hang-read",
    testTimeoutMs: 50
  });
  const hangingReadAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(hangingRead.backend)
  });
  await expect(
    hangingReadAttuneGraph.project(command("read-timeout"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await hangingReadAttuneGraph.close();
  const afterReadTimeout = await openLocalAttuneGraph({
    databasePath: readPath,
    scope: SCOPE
  });
  await expect(
    afterReadTimeout.project(command("after-read-timeout"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterReadTimeout.close();

  const closePath = await temporaryDatabase("close-timeout.sqlite");
  const hangingClose = await openSqliteAttuneGraphStore({
    databasePath: closePath,
    testFault: "hang-close",
    testTimeoutMs: 50
  });
  await expect(hangingClose.close()).rejects.toMatchObject({
    code: "STORE_FAILURE"
  });
  const afterCloseTimeout = await openLocalAttuneGraph({
    databasePath: closePath,
    scope: SCOPE
  });
  await expect(
    afterCloseTimeout.project(command("after-close-timeout"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterCloseTimeout.close();
});
