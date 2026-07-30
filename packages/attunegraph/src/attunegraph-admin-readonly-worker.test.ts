import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";

import {
  type ApplicationQualificationAudit,
  type ApplicationQualificationStage,
  openAttuneGraphAdminReadonlyApplication,
  startAttuneGraphAdminReadonlyApplicationQualification
} from "./attunegraph-admin-readonly-application.js";
import {
  acquireAttuneGraphAdminReadonlySnapshot
} from "./attunegraph-admin-readonly-snapshot.mjs";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 } from "./attunegraph-physical-schema-v1.mjs";

const fixtureDirectories: string[] = [];

function exactAudit(
  overrides: Partial<ApplicationQualificationAudit> & {
    readonly trace: readonly ApplicationQualificationStage[];
  }
): ApplicationQualificationAudit {
  return {
    primaryCode: undefined,
    snapshotAcquireAttempts: 0,
    leasesAcquired: 0,
    workerSpawnAttempts: 0,
    workersSpawned: 0,
    spineInitializeSettlements: 0,
    closeResponses: 0,
    spineCloseSettlements: 0,
    planeATerminalCallbacks: 0,
    pinnedErrorRecoveries: 0,
    workerTerminateCalls: 0,
    workerExitSettlements: 0,
    workerExitCode: undefined,
    leaseReleaseAttempts: 0,
    leaseReleaseSettlements: 0,
    leaseReleaseFailures: 0,
    exactPinnedErrorPreserved: true,
    terminalAuditSettlements: 1,
    ...overrides
  };
}

function expectExactAudit(
  audit: Readonly<ApplicationQualificationAudit>,
  expected: ApplicationQualificationAudit
): void {
  expect(Object.isFrozen(audit)).toBe(true);
  expect(Object.isFrozen(audit.trace)).toBe(true);
  expect(audit).toEqual(expected);
}

async function createDatabaseFixture(
  rows: readonly Readonly<{
    sourceId: string;
    threadId: string;
    generation: bigint;
    commitId: string;
    fingerprint: string;
  }>[] = []
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "attunegraph-admin-application-"))
  );
  fixtureDirectories.push(directory);
  await chmod(directory, 0o700);
  const databasePath = join(directory, "source.sqlite");
  const database = new DatabaseSync(databasePath, { readBigInts: true });
  database.exec(`
    PRAGMA foreign_keys = ON;
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createJournal};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createGenerationIndex};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createHead};
    PRAGMA application_id = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId};
    PRAGMA user_version = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion};
  `);
  const insertJournal = database.prepare(`
    INSERT INTO attunegraph_projection_journal (
      source_id, thread_id, generation, commit_id,
      projection_json, projection_fingerprint
    ) VALUES (?, ?, ?, ?, '{}', ?)
  `);
  const insertHead = database.prepare(`
    INSERT INTO attunegraph_projection_head (
      source_id, thread_id, generation, commit_id
    ) VALUES (?, ?, ?, ?)
  `);
  for (const row of rows) {
    insertJournal.run(
      row.sourceId,
      row.threadId,
      row.generation,
      row.commitId,
      row.fingerprint
    );
    insertHead.run(
      row.sourceId,
      row.threadId,
      row.generation,
      row.commitId
    );
  }
  database.close();
  await chmod(databasePath, 0o600);
  return { databasePath };
}

async function runWorkerWithThrowingClose(databasePath: string) {
  const workerModuleUrl = new URL(
    "./attunegraph-admin-readonly-worker.mjs",
    import.meta.url
  ).href;
  const qualificationSource = `
    import { DatabaseSync } from "node:sqlite";
    let closeCalls = 0;
    Object.defineProperty(DatabaseSync.prototype, "close", {
      configurable: true,
      value() {
        closeCalls += 1;
        throw new Error("qualified close failure");
      }
    });
    process.on("exit", () => {
      if (closeCalls !== 1) process.exitCode = 7;
    });
    await import(${JSON.stringify(workerModuleUrl)});
  `;
  const worker = new Worker(new URL(
    `data:text/javascript,${encodeURIComponent(qualificationSource)}`
  ), {
    name: "attunegraph-admin-readonly-close-qualification",
    execArgv: []
  });
  const messages: unknown[] = [];
  worker.on("message", (message) => messages.push(message));
  const nextMessage = (): Promise<unknown> => new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const exit = new Promise<number>((resolve) => worker.once("exit", resolve));
  try {
    const initialize = nextMessage();
    worker.postMessage({
      protocolVersion: 1,
      id: 1,
      type: "initialize",
      payload: { databasePath }
    });
    const initializeResponse = await initialize;
    if (
      typeof initializeResponse === "object"
      && initializeResponse !== null
      && "ok" in initializeResponse
      && initializeResponse.ok === true
    ) {
      const close = nextMessage();
      worker.postMessage({
        protocolVersion: 1,
        id: 2,
        type: "close",
        payload: {}
      });
      await close;
    }
    return {
      messages,
      exitCode: await exit
    };
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

afterEach(async () => {
  await Promise.all(
    fixtureDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

it("opens an empty closed snapshot through the isolated readonly application", async () => {
  const fixture = await createDatabaseFixture();
  const application = await openAttuneGraphAdminReadonlyApplication({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  });

  expect(Object.isFrozen(application)).toBe(true);
  await expect(application.inspectSummary()).resolves.toMatchObject({
    applicationId: 0x41544731,
    userVersion: 1,
    protocolVersion: 1,
    headRows: 0,
    journalRows: 0,
    maxGeneration: 0
  });
  await expect(application.inspectHead({
    sourceId: "missing",
    threadId: "missing"
  })).resolves.toEqual({ found: false });
  await expect(application.verifyIntegrity()).resolves.toEqual({
    verified: true
  });
  await application.close();
});

it("settles one exact frozen no-fault qualification audit after clean close", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  });
  const application = await qualification.opening;
  const close = application.close();
  expect(application.close()).toBe(close);
  await close;

  expectExactAudit(await qualification.terminalAudit, exactAudit({
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    closeResponses: 1,
    spineCloseSettlements: 1,
    workerExitSettlements: 1,
    workerExitCode: 0,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:success",
      "close:start",
      "close:response",
      "worker:exit",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
});

it("rejects proxy qualification input before executing any trap", async () => {
  let traps = 0;
  const proxy = new Proxy({}, {
    get() {
      traps += 1;
      return undefined;
    },
    getOwnPropertyDescriptor() {
      traps += 1;
      return undefined;
    },
    getPrototypeOf() {
      traps += 1;
      return Object.prototype;
    },
    ownKeys() {
      traps += 1;
      return [];
    }
  });

  const qualification = startAttuneGraphAdminReadonlyApplicationQualification(
    proxy as never
  );
  await expect(qualification.opening).rejects.toMatchObject({
    code: "UNSUPPORTED_PROFILE"
  });
  expectExactAudit(await qualification.terminalAudit, exactAudit({
    primaryCode: "UNSUPPORTED_PROFILE",
    trace: ["terminal:settled"]
  }));
  expect(traps).toBe(0);
});

it("delegates production option admission unchanged to the snapshot authority", async () => {
  const fixture = await createDatabaseFixture();
  let proxyTraps = 0;
  const proxy = new Proxy({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent" as const
  }, {
    get() {
      proxyTraps += 1;
      return undefined;
    },
    getOwnPropertyDescriptor() {
      proxyTraps += 1;
      return undefined;
    },
    getPrototypeOf() {
      proxyTraps += 1;
      return Object.prototype;
    },
    ownKeys() {
      proxyTraps += 1;
      return [];
    }
  });
  await expect(openAttuneGraphAdminReadonlyApplication(proxy)).rejects.toMatchObject({
    code: "UNSUPPORTED_PROFILE"
  });
  expect(proxyTraps).toBe(0);

  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "databasePath", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.databasePath;
    }
  });
  Object.defineProperty(accessor, "sourceState", {
    enumerable: true,
    value: "closed-quiescent"
  });
  const accessorResult = await openAttuneGraphAdminReadonlyApplication(
    accessor as never
  ).then(async (application) => {
    await application.close();
    return "opened";
  }, (error: unknown) => error);
  expect(accessorResult).toMatchObject({ code: "UNSUPPORTED_PROFILE" });
  expect(getterCalls).toBe(0);

  const extraResult = await openAttuneGraphAdminReadonlyApplication({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    workerData: {}
  } as never).then(async (application) => {
    await application.close();
    return "opened";
  }, (error: unknown) => error);
  expect(extraResult).toMatchObject({ code: "UNSUPPORTED_PROFILE" });
});

it("reports a thrown SQLite close as one code-only Worker failure", async () => {
  const fixture = await createDatabaseFixture();
  const lease = await acquireAttuneGraphAdminReadonlySnapshot({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  });
  try {
    const result = await runWorkerWithThrowingClose(
      lease.snapshotDatabasePath
    );
    expect(result).toEqual({
      exitCode: 0,
      messages: [
        {
          protocolVersion: 1,
          id: 1,
          ok: true,
          result: { ready: true }
        },
        {
          protocolVersion: 1,
          id: 2,
          ok: false,
          error: { code: "WORKER_FAILURE" }
        }
      ]
    });
    expect(result.messages).not.toContainEqual({
      protocolVersion: 1,
      id: 2,
      ok: true,
      result: { closed: true }
    });
  } finally {
    await lease.release();
  }
});

it("does not let cleanup close failure replace an earlier inspector code", async () => {
  const fixture = await createDatabaseFixture();
  const source = new DatabaseSync(fixture.databasePath, { readBigInts: true });
  source.exec("PRAGMA user_version = 2");
  source.close();
  const lease = await acquireAttuneGraphAdminReadonlySnapshot({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  });
  try {
    await expect(runWorkerWithThrowingClose(
      lease.snapshotDatabasePath
    )).resolves.toEqual({
      exitCode: 0,
      messages: [
        {
          protocolVersion: 1,
          id: 1,
          ok: false,
          error: { code: "FUTURE_STORE_STATE" }
        }
      ]
    });
  } finally {
    await lease.release();
  }
});

it("returns exact multi-scope results and shares clean close settlement", async () => {
  const fixture = await createDatabaseFixture([
    {
      sourceId: "자료",
      threadId: "é",
      generation: 1n,
      commitId: "commit-a",
      fingerprint: "fingerprint-a"
    },
    {
      sourceId: "자료",
      threadId: "e\u0301",
      generation: 3n,
      commitId: "commit-b",
      fingerprint: "fingerprint-b"
    }
  ]);
  const application = await openAttuneGraphAdminReadonlyApplication({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  });

  await expect(application.inspectSummary()).resolves.toMatchObject({
    headRows: 2,
    journalRows: 2,
    maxGeneration: 3
  });
  await expect(application.inspectHead({
    sourceId: "자료",
    threadId: "e\u0301"
  })).resolves.toEqual({
    found: true,
    head: {
      scope: { sourceId: "자료", threadId: "e\u0301" },
      generation: 3,
      commitId: "commit-b",
      projectionFingerprint: "fingerprint-b"
    }
  });
  const close = application.close();
  expect(application.close()).toBe(close);
  expect(application[Symbol.asyncDispose]()).toBe(close);
  await close;
});

it("releases the acquired lease after a fixed qualification spawn failure", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "spawn-failure"
  });

  await expect(qualification.opening).rejects.toMatchObject({
    code: "WORKER_FAILURE"
  });
  expectExactAudit(await qualification.terminalAudit, exactAudit({
    primaryCode: "WORKER_FAILURE",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:failure",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
});

it("pins initialize timeout, terminates once, then exits before release", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "initialize-timeout"
  });
  let openingError: unknown;
  try {
    await qualification.opening;
  } catch (cause) {
    openingError = cause;
  }
  expect(openingError).toMatchObject({ code: "TIMED_OUT" });

  const audit = await qualification.terminalAudit;
  expectExactAudit(audit, exactAudit({
    primaryCode: "TIMED_OUT",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    workerTerminateCalls: 1,
    workerExitSettlements: 1,
    workerExitCode: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:failure",
      "worker:terminate",
      "worker:exit",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
});

it("turns an idle ready exit into one exact terminal error after release", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "idle-exit-while-ready"
  });
  const application = await qualification.opening;
  const audit = await qualification.terminalAudit;

  expectExactAudit(audit, exactAudit({
    primaryCode: "WORKER_FAILURE",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    planeATerminalCallbacks: 1,
    pinnedErrorRecoveries: 1,
    workerExitSettlements: 1,
    workerExitCode: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:success",
      "plane-a:terminal",
      "e1:error:recovered",
      "worker:exit",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
  const rejections = await Promise.all([
    application.inspectSummary().catch((error: unknown) => error),
    application.inspectHead({
      sourceId: "source",
      threadId: "thread"
    }).catch((error: unknown) => error),
    application.verifyIntegrity().catch((error: unknown) => error),
    application.close().catch((error: unknown) => error)
  ]);
  expect(rejections[0]).toMatchObject({ code: "WORKER_FAILURE" });
  expect(rejections.every((error) => error === rejections[0])).toBe(true);
});

it("waits through delayed Plane B, terminates once, and releases only after exit", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "delayed-plane-b-exit"
  });
  const application = await qualification.opening;
  const audit = await qualification.terminalAudit;

  expectExactAudit(audit, exactAudit({
    primaryCode: "WORKER_FAILURE",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    planeATerminalCallbacks: 1,
    pinnedErrorRecoveries: 1,
    workerTerminateCalls: 1,
    workerExitSettlements: 1,
    workerExitCode: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:success",
      "plane-a:terminal",
      "e1:error:recovered",
      "worker:terminate",
      "worker:exit",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
  const first = await application.close().catch((error: unknown) => error);
  const second = await application.inspectSummary().catch(
    (error: unknown) => error
  );
  expect(first).toMatchObject({ code: "WORKER_FAILURE" });
  expect(second).toBe(first);
});

it("preserves WORKER_FAILURE when the Worker exits before ready", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "forced-exit-before-ready"
  });

  await expect(qualification.opening).rejects.toMatchObject({
    code: "WORKER_FAILURE"
  });
  expectExactAudit(await qualification.terminalAudit, exactAudit({
    primaryCode: "WORKER_FAILURE",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    planeATerminalCallbacks: 1,
    pinnedErrorRecoveries: 1,
    workerExitSettlements: 1,
    workerExitCode: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "plane-a:terminal",
      "spine:initialize:failure",
      "e1:error:recovered",
      "worker:exit",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
});

it("waits for release when the Worker exits during summary inspection", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "forced-exit-on-summary"
  });
  const application = await qualification.opening;
  let operationError: unknown;
  try {
    await application.inspectSummary();
  } catch (cause) {
    operationError = cause;
  }
  expect(operationError).toMatchObject({ code: "WORKER_FAILURE" });

  const audit = await qualification.terminalAudit;
  expectExactAudit(audit, exactAudit({
    primaryCode: "WORKER_FAILURE",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    planeATerminalCallbacks: 1,
    pinnedErrorRecoveries: 1,
    workerExitSettlements: 1,
    workerExitCode: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:success",
      "plane-a:terminal",
      "operation:failure",
      "e1:error:recovered",
      "worker:exit",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
  expect(await application.close().catch((error: unknown) => error)).toBe(
    operationError
  );
});

it("rejects close when exit is nonzero after the accepted close response", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "nonzero-exit-after-close-response"
  });
  const application = await qualification.opening;
  const close = application.close();
  expect(application.close()).toBe(close);
  const closeError = await close.catch((error: unknown) => error);
  expect(closeError).toMatchObject({ code: "WORKER_FAILURE" });

  const audit = await qualification.terminalAudit;
  expectExactAudit(audit, exactAudit({
    primaryCode: "WORKER_FAILURE",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    closeResponses: 1,
    spineCloseSettlements: 1,
    workerExitSettlements: 1,
    workerExitCode: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:success",
      "close:start",
      "close:response",
      "worker:exit",
      "lease:release:start",
      "lease:release:success",
      "terminal:settled"
    ]
  }));
  expect(await application.inspectSummary().catch(
    (error: unknown) => error
  )).toBe(closeError);
});

it("maps a first clean-close release failure to WORKER_FAILURE", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "release-failure-after-clean-close"
  });
  const application = await qualification.opening;
  let closeError: unknown;
  try {
    await application.close();
  } catch (cause) {
    closeError = cause;
  }
  expect(closeError).toMatchObject({ code: "WORKER_FAILURE" });

  const audit = await qualification.terminalAudit;
  expectExactAudit(audit, exactAudit({
    primaryCode: "WORKER_FAILURE",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    closeResponses: 1,
    spineCloseSettlements: 1,
    workerExitSettlements: 1,
    workerExitCode: 0,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    leaseReleaseFailures: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:success",
      "close:start",
      "close:response",
      "worker:exit",
      "lease:release:start",
      "lease:release:failure",
      "terminal:settled"
    ]
  }));
  expect(await application.inspectSummary().catch(
    (error: unknown) => error
  )).toBe(closeError);
});

it("keeps TIMED_OUT ahead of a later release failure", async () => {
  const fixture = await createDatabaseFixture();
  const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent",
    fault: "initialize-timeout-with-release-failure"
  });
  let openingError: unknown;
  try {
    await qualification.opening;
  } catch (cause) {
    openingError = cause;
  }
  expect(openingError).toMatchObject({ code: "TIMED_OUT" });

  const audit = await qualification.terminalAudit;
  expectExactAudit(audit, exactAudit({
    primaryCode: "TIMED_OUT",
    snapshotAcquireAttempts: 1,
    leasesAcquired: 1,
    workerSpawnAttempts: 1,
    workersSpawned: 1,
    spineInitializeSettlements: 1,
    workerTerminateCalls: 1,
    workerExitSettlements: 1,
    workerExitCode: 1,
    leaseReleaseAttempts: 1,
    leaseReleaseSettlements: 1,
    leaseReleaseFailures: 1,
    trace: [
      "snapshot:acquire:start",
      "snapshot:acquire:success",
      "worker:spawn:start",
      "worker:spawn:success",
      "spine:initialize:start",
      "spine:initialize:failure",
      "worker:terminate",
      "worker:exit",
      "lease:release:start",
      "lease:release:failure",
      "terminal:settled"
    ]
  }));
});

it("preserves a genuine inspector FUTURE_STORE_STATE code", async () => {
  const fixture = await createDatabaseFixture();
  const database = new DatabaseSync(fixture.databasePath, {
    readBigInts: true
  });
  database.exec("PRAGMA user_version = 2");
  database.close();

  await expect(openAttuneGraphAdminReadonlyApplication({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  })).rejects.toMatchObject({ code: "FUTURE_STORE_STATE" });
});

it("never follows post-acquisition changes back to the source store", async () => {
  const fixture = await createDatabaseFixture();
  const application = await openAttuneGraphAdminReadonlyApplication({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  });
  const source = new DatabaseSync(fixture.databasePath, { readBigInts: true });
  source.exec(`
    PRAGMA foreign_keys = ON;
    INSERT INTO attunegraph_projection_journal (
      source_id, thread_id, generation, commit_id,
      projection_json, projection_fingerprint
    ) VALUES ('later', 'later', 1, 'later', '{}', 'later');
    INSERT INTO attunegraph_projection_head (
      source_id, thread_id, generation, commit_id
    ) VALUES ('later', 'later', 1, 'later');
  `);
  source.close();

  await expect(application.inspectSummary()).resolves.toMatchObject({
    headRows: 0,
    journalRows: 0,
    maxGeneration: 0
  });
  await expect(application.inspectHead({
    sourceId: "later",
    threadId: "later"
  })).resolves.toEqual({ found: false });
  await application.close();
});

it("keeps close REENTRY nonterminal and permits a clean retry", async () => {
  const fixture = await createDatabaseFixture();
  const application = await openAttuneGraphAdminReadonlyApplication({
    databasePath: fixture.databasePath,
    sourceState: "closed-quiescent"
  });

  const inspection = application.verifyIntegrity();
  await expect(application.close()).rejects.toMatchObject({ code: "REENTRY" });
  await expect(inspection).resolves.toEqual({ verified: true });
  await expect(application.close()).resolves.toBeUndefined();
});

it("rejects accessors and caller authority fields before acquisition", async () => {
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "databasePath", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "/unused";
    }
  });
  Object.defineProperty(accessor, "sourceState", {
    enumerable: true,
    value: "closed-quiescent"
  });
  const accessorQualification =
    startAttuneGraphAdminReadonlyApplicationQualification(accessor as never);
  await expect(accessorQualification.opening).rejects.toMatchObject({
    code: "UNSUPPORTED_PROFILE"
  });
  expectExactAudit(await accessorQualification.terminalAudit, exactAudit({
    primaryCode: "UNSUPPORTED_PROFILE",
    trace: ["terminal:settled"]
  }));
  expect(getterCalls).toBe(0);

  for (const extra of [
    { workerData: {} },
    { transport: {} },
    { clock: {} },
    { callback() {} },
    { error: new Error("forged") },
    { sql: "DELETE FROM attunegraph_projection_head" },
    { timeout: 1 },
    { lease: {} },
    { counterBuffer: new SharedArrayBuffer(4) }
  ]) {
    const qualification = startAttuneGraphAdminReadonlyApplicationQualification({
      databasePath: "/unused",
      sourceState: "closed-quiescent",
      ...extra
    } as never);
    await expect(qualification.opening).rejects.toMatchObject({
      code: "UNSUPPORTED_PROFILE"
    });
    expectExactAudit(await qualification.terminalAudit, exactAudit({
      primaryCode: "UNSUPPORTED_PROFILE",
      trace: ["terminal:settled"]
    }));
  }
});
