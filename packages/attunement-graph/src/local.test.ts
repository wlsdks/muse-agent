import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { afterEach, expect, it } from "vitest";

import { createInMemoryMagStore } from "./mag-in-memory-store.js";
import { createMagStore } from "./mag-backend.js";
import type { MagProjectCommand, MagScope } from "./mag-contracts.js";
import { openMag } from "./mag-engine.js";
import { openLocalMag } from "./local.js";
import { openSqliteMagStore } from "./mag-sqlite-store.js";
import { runMagStoreConformance } from "./mag-testing.js";

const NOW = "2026-07-30T00:00:00.000Z";
const SCOPE: MagScope = {
  sourceId: "local-source",
  threadId: "local-thread"
};
const temporaryDirectories: string[] = [];

async function temporaryDatabase(name = "mag.sqlite"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "muse-mag-local-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return join(canonicalDirectory, name);
}

function command(
  key: string,
  scope: MagScope = SCOPE
): MagProjectCommand {
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
        sourceRefs: [{ id: `source-ref-${key}`, namespace: "muse.local-test" }],
        recordedAt: NOW,
        derivation: { kind: "projection", version: "local-test@1" }
      }]
    }
  };
}

function execute(scope: MagScope = SCOPE) {
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
    openLocalMag(new Proxy(options, {}))
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
  await expect(openLocalMag(accessor as never)).rejects.toMatchObject({
    code: "INVALID_INPUT"
  });
  await expect(lstat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("persists and reopens byte-identical Engine snapshots and results", async () => {
  const databasePath = await temporaryDatabase();
  const local = await openLocalMag({ databasePath, scope: SCOPE });
  const memory = await openMag({
    scope: SCOPE,
    store: createInMemoryMagStore()
  });
  const input = command("restart");

  const [localSnapshot, memorySnapshot] = await Promise.all([
    local.project(input),
    memory.project(input)
  ]);
  const [localResult, memoryResult] = await Promise.all([
    local.execute(execute()),
    memory.execute(execute())
  ]);
  expect(JSON.stringify(localSnapshot)).toBe(JSON.stringify(memorySnapshot));
  expect(JSON.stringify(localResult)).toBe(JSON.stringify(memoryResult));
  await Promise.all([local.close(), memory.close()]);

  const reopened = await openLocalMag({ databasePath, scope: SCOPE });
  expect(JSON.stringify(await reopened.project(input))).toBe(
    JSON.stringify(localSnapshot)
  );
  expect(JSON.stringify(await reopened.execute(execute()))).toBe(
    JSON.stringify(localResult)
  );
  await reopened.close();
  await reopened.close();
  await expect(reopened.project(input)).rejects.toMatchObject({ code: "CLOSED" });
  await expect(reopened.execute(execute())).rejects.toMatchObject({ code: "CLOSED" });
});

it("reopens the pre-refactor AWG-070a1 physical-profile fixture", async () => {
  const databasePath = await temporaryDatabase("awg070a1-compat.sqlite");
  const encoded = await readFile(
    new URL("./fixtures/awg-070a1-sqlite-v1.base64", import.meta.url),
    "utf8"
  );
  const fixture = gunzipSync(Buffer.from(encoded.trim(), "base64"));
  expect(createHash("sha256").update(fixture).digest("hex")).toBe(
    "0b44d5cf634fbbed3c38125613250727739bb4e014a2846bc0d343521da63504"
  );
  await writeFile(databasePath, fixture, { mode: 0o600 });

  const scope = { sourceId: "compat-source", threadId: "compat-thread" };
  const reopened = await openLocalMag({ databasePath, scope });
  const before = await reopened.execute(execute(scope));
  expect(before.snapshot).toMatchObject({ generation: 1, scope });
  const after = await reopened.project({
    ...command("awg070a2-compatible-cas", scope),
    expectedSnapshot: before.snapshot
  });
  expect(after.generation).toBe(2);
  await reopened.close();
});

it("linearizes two independent Worker connections on one file", async () => {
  const databasePath = await temporaryDatabase();
  const first = await openLocalMag({ databasePath, scope: SCOPE });
  const second = await openLocalMag({ databasePath, scope: SCOPE });

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
  const left = await openLocalMag({ databasePath: identicalPath, scope: SCOPE });
  const right = await openLocalMag({ databasePath: identicalPath, scope: SCOPE });
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
  const mag = await openLocalMag({ databasePath, scope: SCOPE });
  await mag.project(command("permissions"));

  const databaseMode = (await lstat(databasePath)).mode & 0o777;
  expect(databaseMode).toBe(0o600);
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    const mode = (await lstat(sidecar)).mode & 0o777;
    expect(mode).toBe(0o600);
  }
  await mag.close();

  const symlinkPath = join(
    databasePath.slice(0, databasePath.lastIndexOf("/")),
    "linked.sqlite"
  );
  await symlink(databasePath, symlinkPath);
  await expect(
    openLocalMag({ databasePath: symlinkPath, scope: SCOPE })
  ).rejects.toMatchObject({
    code: expect.stringMatching(/^(INVALID_INPUT|UNSUPPORTED_STORE_PROFILE)$/u)
  });

  const realDirectory = await realpath(join(databasePath, ".."));
  const linkedDirectory = join(realDirectory, "linked-parent");
  const targetDirectory = join(realDirectory, "target-parent");
  await mkdir(targetDirectory, { mode: 0o700 });
  await symlink(targetDirectory, linkedDirectory);
  await expect(
    openLocalMag({
      databasePath: join(linkedDirectory, "redirected.sqlite"),
      scope: SCOPE
    })
  ).rejects.toMatchObject({ code: "UNSUPPORTED_STORE_PROFILE" });
});

it("passes the backend-neutral Store conformance corpus with disposal", async () => {
  const report = await runMagStoreConformance(async () =>
    openSqliteMagStore({ databasePath: await temporaryDatabase() })
  );
  expect(report).toMatchObject({ passed: true });
  expect(report.cases).toHaveLength(5);
});

it("recovers the three commit and acknowledgement crash boundaries", async () => {
  const beforeCommitPath = await temporaryDatabase("before-commit.sqlite");
  const beforeCommitResource = await openSqliteMagStore({
    databasePath: beforeCommitPath,
    testFault: "before-commit"
  });
  const beforeCommitMag = await openMag({
    scope: SCOPE,
    store: createMagStore(beforeCommitResource.backend)
  });
  await expect(
    beforeCommitMag.project(command("before-commit"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await beforeCommitMag.close();

  const beforeCommitReopen = await openLocalMag({
    databasePath: beforeCommitPath,
    scope: SCOPE
  });
  const firstAfterRollback = await beforeCommitReopen.project(
    command("after-rollback")
  );
  expect(firstAfterRollback.generation).toBe(1);
  await beforeCommitReopen.close();

  const lostAckPath = await temporaryDatabase("lost-ack.sqlite");
  const lostAckResource = await openSqliteMagStore({
    databasePath: lostAckPath,
    testFault: "after-commit-before-ack"
  });
  const lostAckMag = await openMag({
    scope: SCOPE,
    store: createMagStore(lostAckResource.backend)
  });
  const lostAckCommand = command("lost-ack");
  await expect(lostAckMag.project(lostAckCommand)).rejects.toMatchObject({
    code: "STORE_FAILURE"
  });
  await lostAckMag.close();

  const lostAckReopen = await openLocalMag({
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
  const acknowledgedResource = await openSqliteMagStore({
    databasePath: acknowledgedPath
  });
  const acknowledgedMag = await openMag({
    scope: SCOPE,
    store: createMagStore(acknowledgedResource.backend)
  });
  const acknowledgedSnapshot = await acknowledgedMag.project(
    command("acknowledged")
  );
  await acknowledgedResource.terminateForTesting();
  await expect(
    acknowledgedMag.execute(execute())
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await acknowledgedMag.close();

  const acknowledgedReopen = await openLocalMag({
    databasePath: acknowledgedPath,
    scope: SCOPE
  });
  const recoveredAcknowledged = await acknowledgedReopen.execute(execute());
  expect(recoveredAcknowledged.snapshot).toEqual(acknowledgedSnapshot);
  await acknowledgedReopen.close();
});

it("fails closed for future, foreign, malformed, orphaned, and NOTADB state", async () => {
  const futurePath = await temporaryDatabase("future.sqlite");
  const future = await openSqliteMagStore({
    databasePath: futurePath,
    testFixtureMode: true
  });
  await future.mutateForTesting("future-user-version");
  await future.close();
  await expect(
    openLocalMag({ databasePath: futurePath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "FUTURE_STORE_STATE" });

  const foreignPath = await temporaryDatabase("foreign.sqlite");
  const foreign = await openSqliteMagStore({
    databasePath: foreignPath,
    testFixtureMode: true
  });
  await foreign.mutateForTesting("wrong-application-id");
  await foreign.close();
  await expect(
    openLocalMag({ databasePath: foreignPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const malformedPath = await temporaryDatabase("malformed.sqlite");
  const malformed = await openSqliteMagStore({
    databasePath: malformedPath,
    testFixtureMode: true
  });
  const malformedMag = await openMag({
    scope: SCOPE,
    store: createMagStore(malformed.backend)
  });
  await malformedMag.project(command("malformed"));
  await malformed.mutateForTesting("malformed-projection-json");
  await malformedMag.close();
  await malformed.close();
  const malformedReopen = await openLocalMag({
    databasePath: malformedPath,
    scope: SCOPE
  });
  await expect(
    malformedReopen.execute(execute())
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  await malformedReopen.close();

  const orphanPath = await temporaryDatabase("orphan.sqlite");
  const orphan = await openSqliteMagStore({
    databasePath: orphanPath,
    testFixtureMode: true
  });
  const orphanMag = await openMag({
    scope: SCOPE,
    store: createMagStore(orphan.backend)
  });
  await orphanMag.project(command("orphan"));
  await orphan.mutateForTesting("missing-journal-row");
  await orphanMag.close();
  await orphan.close();
  await expect(
    openLocalMag({ databasePath: orphanPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const partialPath = await temporaryDatabase("partial-bootstrap.sqlite");
  const partial = await openSqliteMagStore({
    databasePath: partialPath,
    testFixtureMode: true
  });
  await partial.mutateForTesting("partial-bootstrap");
  await partial.close();
  await expect(
    openLocalMag({ databasePath: partialPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const oversizedPath = await temporaryDatabase("oversized.sqlite");
  const oversized = await openSqliteMagStore({
    databasePath: oversizedPath,
    testFixtureMode: true
  });
  const oversizedMag = await openMag({
    scope: SCOPE,
    store: createMagStore(oversized.backend)
  });
  await oversizedMag.project(command("oversized"));
  await oversized.mutateForTesting("oversized-projection-json");
  await oversizedMag.close();
  await oversized.close();
  await expect(
    openLocalMag({ databasePath: oversizedPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const mismatchedPath = await temporaryDatabase("mismatched.sqlite");
  const mismatched = await openSqliteMagStore({
    databasePath: mismatchedPath,
    testFixtureMode: true
  });
  const mismatchedMag = await openMag({
    scope: SCOPE,
    store: createMagStore(mismatched.backend)
  });
  await mismatchedMag.project(command("mismatched"));
  await mismatched.mutateForTesting("mismatched-head");
  await mismatchedMag.close();
  await mismatched.close();
  await expect(
    openLocalMag({ databasePath: mismatchedPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const quickCheckPath = await temporaryDatabase("quick-check.sqlite");
  const quickCheck = await openSqliteMagStore({
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
    const unexpected = await openLocalMag({
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
    openLocalMag({ databasePath: notDatabasePath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });
});

it("proves stale cross-Worker CAS, monotone generations, and exact physical counts", async () => {
  const databasePath = await temporaryDatabase("multi-generation.sqlite");
  const firstResource = await openSqliteMagStore({
    databasePath,
    testFixtureMode: true
  });
  const secondResource = await openSqliteMagStore({
    databasePath,
    testFixtureMode: true
  });
  const first = await openMag({
    scope: SCOPE,
    store: createMagStore(firstResource.backend)
  });
  const second = await openMag({
    scope: SCOPE,
    store: createMagStore(secondResource.backend)
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
  const holder = await openSqliteMagStore({
    databasePath,
    testFixtureMode: true
  });
  const contender = await openSqliteMagStore({
    databasePath,
    testFixtureMode: true
  });
  const contenderMag = await openMag({
    scope: SCOPE,
    store: createMagStore(contender.backend)
  });

  await holder.holdWriteLockForTesting(1_500);
  await expect(
    contenderMag.project(command("busy-contender"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  expect(await holder.inspectForTesting()).toEqual({
    headRows: 0,
    journalRows: 0,
    maxGeneration: 0
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  await contenderMag.close();
  await Promise.all([holder.close(), contender.close()]);
});

it("awaits request and close timeout termination before the file can reopen", async () => {
  const lateReplyPath = await temporaryDatabase("late-reply.sqlite");
  const lateReply = await openSqliteMagStore({
    databasePath: lateReplyPath,
    testResponseDelayMs: 75,
    testTimeoutMs: 50
  });
  const lateReplyMag = await openMag({
    scope: SCOPE,
    store: createMagStore(lateReply.backend)
  });
  await expect(
    lateReplyMag.project(command("late-reply"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await lateReplyMag.close();
  const afterLateReply = await openLocalMag({
    databasePath: lateReplyPath,
    scope: SCOPE
  });
  await expect(
    afterLateReply.project(command("after-late-reply"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterLateReply.close();

  const readPath = await temporaryDatabase("read-timeout.sqlite");
  const hangingRead = await openSqliteMagStore({
    databasePath: readPath,
    testFault: "hang-read",
    testTimeoutMs: 50
  });
  const hangingReadMag = await openMag({
    scope: SCOPE,
    store: createMagStore(hangingRead.backend)
  });
  await expect(
    hangingReadMag.project(command("read-timeout"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await hangingReadMag.close();
  const afterReadTimeout = await openLocalMag({
    databasePath: readPath,
    scope: SCOPE
  });
  await expect(
    afterReadTimeout.project(command("after-read-timeout"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterReadTimeout.close();

  const closePath = await temporaryDatabase("close-timeout.sqlite");
  const hangingClose = await openSqliteMagStore({
    databasePath: closePath,
    testFault: "hang-close",
    testTimeoutMs: 50
  });
  await expect(hangingClose.close()).rejects.toMatchObject({
    code: "STORE_FAILURE"
  });
  const afterCloseTimeout = await openLocalMag({
    databasePath: closePath,
    scope: SCOPE
  });
  await expect(
    afterCloseTimeout.project(command("after-close-timeout"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterCloseTimeout.close();
});
