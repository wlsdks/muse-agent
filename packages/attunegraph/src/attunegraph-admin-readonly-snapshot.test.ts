import {
  chmod,
  link,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

import {
  acquireAttuneGraphAdminReadonlySnapshot,
  readAttuneGraphAdminReadonlySnapshotFailure,
  startAttuneGraphAdminReadonlySnapshotQualification
} from "./attunegraph-admin-readonly-snapshot.mjs";

async function sourceFixture(entries: Readonly<Record<string, string>>) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "attunegraph-snapshot-source-"))
  );
  await chmod(directory, 0o700);
  const databasePath = join(directory, "source.sqlite");
  for (const [suffix, content] of Object.entries(entries)) {
    const path = `${databasePath}${suffix}`;
    await writeFile(path, content, { mode: 0o600 });
    await chmod(path, 0o600);
  }
  return { databasePath, directory };
}

async function expectFailureCode(
  promise: Promise<unknown>,
  code: ReturnType<typeof readAttuneGraphAdminReadonlySnapshotFailure>
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => readAttuneGraphAdminReadonlySnapshotFailure(error) === code
  );
}

it("acquires an exact private snapshot without invoking unsafe option fields", async () => {
  const fixture = await sourceFixture({ "": "main-bytes" });
  try {
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
    await expect(acquireAttuneGraphAdminReadonlySnapshot(accessor)).rejects.toSatisfy(
      (error: unknown) =>
        readAttuneGraphAdminReadonlySnapshotFailure(error) === "UNSUPPORTED_PROFILE"
    );
    expect(getterCalls).toBe(0);

    const lease = await acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(await readFile(lease.snapshotDatabasePath, "utf8")).toBe("main-bytes");
    expect(lease.sourceManifest.main).toMatchObject({
      state: "present",
      size: 10,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
    expect(lease.sourceManifest["-journal"]).toEqual({ state: "absent" });
    expect(lease.sourceManifest["-wal"]).toEqual({ state: "absent" });
    expect(lease.sourceManifest["-shm"]).toEqual({ state: "absent" });
    const release = lease.release();
    expect(lease.release()).toBe(release);
    expect(lease[Symbol.asyncDispose]()).toBe(release);
    await release;
    await expect(readFile(lease.snapshotDatabasePath)).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(dirname(lease.snapshotDatabasePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

it("releases a bounded owner-private SQLite sidecar created after capture", async () => {
  const fixture = await sourceFixture({ "": "main-bytes" });
  try {
    const lease = await acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    });
    const lateSidecar = `${lease.snapshotDatabasePath}-shm`;
    await writeFile(lateSidecar, "sqlite-readonly-sidecar", { mode: 0o600 });
    await chmod(lateSidecar, 0o600);

    await lease.release();

    await expect(readFile(lateSidecar)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(dirname(lease.snapshotDatabasePath))).rejects.toMatchObject({
      code: "ENOENT"
    });
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

it("brands only same-module failures and rejects proxy or forged authority", async () => {
  const fixture = await sourceFixture({ "": "main" });
  try {
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
    await expect(acquireAttuneGraphAdminReadonlySnapshot(proxy)).rejects.toSatisfy(
      (error: unknown) =>
        readAttuneGraphAdminReadonlySnapshotFailure(error) === "UNSUPPORTED_PROFILE"
    );
    expect(traps).toBe(0);

    let genuine: unknown;
    try {
      await acquireAttuneGraphAdminReadonlySnapshot({
        databasePath: join(fixture.directory, "missing.sqlite"),
        sourceState: "closed-quiescent"
      });
    } catch (error) {
      genuine = error;
    }
    expect(readAttuneGraphAdminReadonlySnapshotFailure(genuine)).toBe("SOURCE_NOT_FOUND");
    expect(Object.isFrozen(genuine)).toBe(true);
    expect(readAttuneGraphAdminReadonlySnapshotFailure({
      name: "AttuneGraphAdminReadonlySnapshotFailure",
      message: "Admin snapshot source was not found"
    })).toBeUndefined();
    expect(readAttuneGraphAdminReadonlySnapshotFailure(
      runInNewContext("new Error('Admin snapshot source was not found')")
    )).toBeUndefined();

    const lease = await acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    });
    await expect(lease.release.call({})).rejects.toSatisfy(
      (error: unknown) =>
        readAttuneGraphAdminReadonlySnapshotFailure(error) === "WORKER_FAILURE"
    );
    await lease.release();
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

it("settles qualification audit when proxy or accessor admission rejects", async () => {
  let trapCalls = 0;
  const proxy = new Proxy({}, {
    get() {
      trapCalls += 1;
      return undefined;
    },
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      return undefined;
    },
    getPrototypeOf() {
      trapCalls += 1;
      return Object.prototype;
    },
    ownKeys() {
      trapCalls += 1;
      return [];
    }
  });
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

  for (const input of [proxy, accessor]) {
    const qualification = startAttuneGraphAdminReadonlySnapshotQualification(input);
    await expectFailureCode(qualification.acquisition, "UNSUPPORTED_PROFILE");
    expect(await qualification.terminalAudit).toMatchObject({
      primaryCode: "UNSUPPORTED_PROFILE",
      cleanupAttempts: 0,
      sourceFdsOpened: 0,
      sourceFdsClosed: 0,
      copyFdsOpened: 0,
      copyFdsClosed: 0,
      directoryFdClosed: 0,
      terminalAuditSettlements: 1
    });
  }
  expect(trapCalls).toBe(0);
  expect(getterCalls).toBe(0);
});

it("owns and removes the temp child across every construction failure edge", async () => {
  const cases = [
    ["temp-child-chmod-failure", "WORKER_FAILURE", 0],
    ["temp-child-open-failure", "WORKER_FAILURE", 0],
    ["temp-child-stat-failure", "WORKER_FAILURE", 1],
    ["temp-child-profile-failure", "UNSUPPORTED_PROFILE", 1]
  ] as const;
  for (const [fault, code, directoryFdClosed] of cases) {
    const fixture = await sourceFixture({ "": "main" });
    try {
      const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
        databasePath: fixture.databasePath,
        sourceState: "closed-quiescent",
        fault
      });
      await expectFailureCode(qualification.acquisition, code);
      expect(await qualification.terminalAudit).toMatchObject({
        primaryCode: code,
        cleanupAttempts: 1,
        cleanupFailures: 0,
        directoryPhase: 1,
        directoryFdClosed,
        terminalAuditSettlements: 1,
        trace: expect.arrayContaining([
          "construction-cleanup-start",
          "construction-cleanup-removed"
        ])
      });
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  }
});

it("copies every stable sidecar combination into an exact frozen manifest", async () => {
  const sidecars = ["-journal", "-wal", "-shm"] as const;
  for (let mask = 0; mask < 8; mask += 1) {
    const entries: Record<string, string> = { "": "m".repeat(70_001) };
    for (let index = 0; index < sidecars.length; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        entries[sidecars[index]!] = `${sidecars[index]}-${mask}`;
      }
    }
    const fixture = await sourceFixture(entries);
    try {
      const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
        databasePath: fixture.databasePath,
        sourceState: "closed-quiescent"
      });
      const lease = await qualification.acquisition;
      expect(Reflect.ownKeys(lease)).toEqual([
        "snapshotDatabasePath",
        "sourceManifest",
        "release",
        Symbol.asyncDispose
      ]);
      expect(Object.isFrozen(lease.sourceManifest)).toBe(true);
      for (const [index, suffix] of ["", ...sidecars].entries()) {
        const manifestKey = index === 0 ? "main" : suffix;
        const entry = lease.sourceManifest[
          manifestKey as keyof typeof lease.sourceManifest
        ];
        const content = entries[suffix];
        if (content === undefined) {
          expect(entry).toEqual({ state: "absent" });
          continue;
        }
        expect(entry).toMatchObject({
          state: "present",
          size: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex")
        });
        expect(Object.isFrozen(entry)).toBe(true);
        const copyName = index === 0 ? "store.sqlite" : `store.sqlite${suffix}`;
        expect(await readFile(join(dirname(lease.snapshotDatabasePath), copyName), "utf8"))
          .toBe(content);
      }
      const generatedNames = await readdir(dirname(lease.snapshotDatabasePath));
      expect(generatedNames.sort()).toEqual([
        ".attunegraph-admin-lease-v1.json",
        ...Object.keys(entries).map((suffix) =>
          suffix === "" ? "store.sqlite" : `store.sqlite${suffix}`
        )
      ].sort());
      const marker = await readFile(
        join(dirname(lease.snapshotDatabasePath), ".attunegraph-admin-lease-v1.json"),
        "utf8"
      );
      expect(Buffer.byteLength(marker)).toBeLessThanOrEqual(512);
      expect(marker).not.toContain(fixture.databasePath);
      expect(JSON.parse(marker)).toMatchObject({
        schemaVersion: 1,
        leaseId: expect.stringMatching(/^[0-9a-f]{64}$/u),
        directory: {
          dev: expect.stringMatching(/^\d+$/u),
          ino: expect.stringMatching(/^\d+$/u),
          uid: typeof process.geteuid === "function" ? process.geteuid() : -1
        }
      });
      await lease.release();
      const audit = await qualification.terminalAudit;
      expect(audit).toMatchObject({
        cleanupAttempts: 1,
        cleanupFailures: 0,
        cleanupInterruptions: 0,
        dataPhaseBits: 0b1111,
        markerPhase: 1,
        directoryPhase: 1,
        sourceFdsOpened: 2 * Object.keys(entries).length,
        sourceFdsClosed: 2 * Object.keys(entries).length,
        copyFdsOpened: 2 * Object.keys(entries).length + 1,
        copyFdsClosed: 2 * Object.keys(entries).length + 1,
        directoryFdClosed: 1,
        terminalAuditSettlements: 1
      });
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  }
});

it("maps closed qualification faults to fixed first-terminal codes", async () => {
  const cases = [
    ["wrong-owner-profile", "UNSUPPORTED_PROFILE"],
    ["cross-device-sidecar-profile", "UNSUPPORTED_PROFILE"],
    ["unsupported-temp-filesystem-profile", "UNSUPPORTED_PROFILE"],
    ["source-change-before-final-check", "STORE_BUSY"],
    ["deadline-after-first-read", "STORE_BUSY"],
    ["source-read-failure", "WORKER_FAILURE"],
    ["source-hash-failure", "WORKER_FAILURE"],
    ["temp-directory-failure", "WORKER_FAILURE"],
    ["copy-write-failure", "WORKER_FAILURE"],
    ["marker-write-failure", "WORKER_FAILURE"]
  ] as const;
  for (const [fault, code] of cases) {
    const fixture = await sourceFixture({
      "": "main",
      "-journal": "journal",
      "-wal": "wal",
      "-shm": "shm"
    });
    try {
      const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
        databasePath: fixture.databasePath,
        sourceState: "closed-quiescent",
        fault
      });
      await expect(qualification.acquisition).rejects.toSatisfy(
        (error: unknown) =>
          readAttuneGraphAdminReadonlySnapshotFailure(error) === code
      );
      const audit = await qualification.terminalAudit;
      expect(audit.primaryCode).toBe(code);
      expect(audit.sourceFdsOpened).toBe(audit.sourceFdsClosed);
      expect(audit.copyFdsOpened).toBe(audit.copyFdsClosed);
      expect(audit.terminalAuditSettlements).toBe(1);
      if (fault === "unsupported-temp-filesystem-profile") {
        expect(audit.trace).not.toContain("directory-admitted");
      }
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  }
});

it("quarantines an existing marker when acquisition never pinned its identity", async () => {
  const fixture = await sourceFixture({ "": "main" });
  try {
    const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent",
      fault: "marker-write-failure"
    });
    await expectFailureCode(qualification.acquisition, "WORKER_FAILURE");
    expect(await qualification.terminalAudit).toMatchObject({
      primaryCode: "WORKER_FAILURE",
      cleanupAttempts: 1,
      cleanupFailures: 1,
      dataPhaseBits: 0b1111,
      markerPhase: 0,
      directoryPhase: 0,
      directoryFdClosed: 1,
      terminalAuditSettlements: 1
    });
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

it("preserves STORE_BUSY when later cleanup fails and brands cleanup-first failure", async () => {
  const primaryFixture = await sourceFixture({ "": "main" });
  try {
    const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
      databasePath: primaryFixture.databasePath,
      sourceState: "closed-quiescent",
      fault: "cleanup-failure-after-primary"
    });
    await expect(qualification.acquisition).rejects.toSatisfy(
      (error: unknown) =>
        readAttuneGraphAdminReadonlySnapshotFailure(error) === "STORE_BUSY"
    );
    expect(await qualification.terminalAudit).toMatchObject({
      primaryCode: "STORE_BUSY",
      cleanupAttempts: 1,
      cleanupFailures: 1,
      dataPhaseBits: 0,
      markerPhase: 0,
      directoryPhase: 0,
      directoryFdClosed: 1,
      terminalAuditSettlements: 1
    });
  } finally {
    await rm(primaryFixture.directory, { force: true, recursive: true });
  }

  const cleanupFixture = await sourceFixture({ "": "main" });
  try {
    const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
      databasePath: cleanupFixture.databasePath,
      sourceState: "closed-quiescent",
      fault: "cleanup-first-failure"
    });
    const lease = await qualification.acquisition;
    await expect(lease.release()).rejects.toSatisfy(
      (error: unknown) =>
        readAttuneGraphAdminReadonlySnapshotFailure(error) === "WORKER_FAILURE"
    );
    expect(await qualification.terminalAudit).toMatchObject({
      cleanupAttempts: 1,
      cleanupFailures: 1,
      dataPhaseBits: 0,
      markerPhase: 0,
      directoryPhase: 0,
      directoryFdClosed: 1,
      terminalAuditSettlements: 1
    });
  } finally {
    await rm(cleanupFixture.directory, { force: true, recursive: true });
  }
});

it("resumes every marker-last cleanup interruption within one cached release", async () => {
  const faults = [
    "interrupt-after-main-unlink",
    "interrupt-after-journal-unlink",
    "interrupt-after-wal-unlink",
    "interrupt-after-shm-unlink",
    "interrupt-after-marker-unlink",
    "interrupt-before-directory-remove"
  ] as const;
  for (const fault of faults) {
    const fixture = await sourceFixture({
      "": "main",
      "-journal": "journal",
      "-wal": "wal",
      "-shm": "shm"
    });
    try {
      const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
        databasePath: fixture.databasePath,
        sourceState: "closed-quiescent",
        fault
      });
      const lease = await qualification.acquisition;
      const release = lease.release();
      expect(lease.release()).toBe(release);
      expect(lease[Symbol.asyncDispose]()).toBe(release);
      await release;
      const audit = await qualification.terminalAudit;
      expect(audit).toMatchObject({
        cleanupAttempts: 1,
        cleanupFailures: 0,
        cleanupInterruptions: 1,
        dataPhaseBits: 0b1111,
        markerPhase: 1,
        directoryPhase: 1,
        directoryFdClosed: 1,
        terminalAuditSettlements: 1
      });
      expect(audit.trace).toContain(`interrupt:${fault}`);
      expect(audit.trace).toContain(`resume:${fault}`);
      expect(audit.trace.indexOf(`interrupt:${fault}`))
        .toBeLessThan(audit.trace.indexOf(`resume:${fault}`));
      expect(audit.trace.indexOf("data-3-complete"))
        .toBeLessThan(audit.trace.indexOf("marker-complete"));
      expect(audit.trace.indexOf("marker-complete"))
        .toBeLessThan(audit.trace.indexOf("directory-complete"));
    } finally {
      await rm(fixture.directory, { force: true, recursive: true });
    }
  }
});

it("quarantines an unexpected generated-directory entry without removing the marker", async () => {
  const fixture = await sourceFixture({ "": "main" });
  let generatedDirectory: string | undefined;
  try {
    const qualification = startAttuneGraphAdminReadonlySnapshotQualification({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    });
    const lease = await qualification.acquisition;
    generatedDirectory = dirname(lease.snapshotDatabasePath);
    await writeFile(join(generatedDirectory, "foreign-entry"), "foreign", {
      mode: 0o600
    });
    await expect(lease.release()).rejects.toSatisfy(
      (error: unknown) =>
        readAttuneGraphAdminReadonlySnapshotFailure(error) === "WORKER_FAILURE"
    );
    expect(await readFile(join(
      generatedDirectory,
      ".attunegraph-admin-lease-v1.json"
    ), "utf8")).toContain("\"schemaVersion\":1");
    expect(await readFile(join(generatedDirectory, "foreign-entry"), "utf8"))
      .toBe("foreign");
    expect(await qualification.terminalAudit).toMatchObject({
      cleanupAttempts: 1,
      cleanupFailures: 1,
      dataPhaseBits: 0,
      markerPhase: 0,
      directoryPhase: 0,
      directoryFdClosed: 1,
      terminalAuditSettlements: 1
    });
  } finally {
    if (generatedDirectory !== undefined) {
      await rm(generatedDirectory, { force: true, recursive: true });
    }
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

it("rejects unsupported path, ownership, mode, link, symlink, and size profiles", async () => {
  await expectFailureCode(acquireAttuneGraphAdminReadonlySnapshot({
    databasePath: "relative.sqlite",
    sourceState: "closed-quiescent"
  }), "UNSUPPORTED_PROFILE");

  const fixture = await sourceFixture({ "": "main" });
  try {
    await chmod(fixture.directory, 0o755);
    await expectFailureCode(acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    }), "UNSUPPORTED_PROFILE");
    await chmod(fixture.directory, 0o700);

    await chmod(fixture.databasePath, 0o644);
    await expectFailureCode(acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    }), "UNSUPPORTED_PROFILE");
    await chmod(fixture.databasePath, 0o600);

    const secondLink = join(fixture.directory, "second-link");
    await link(fixture.databasePath, secondLink);
    await expectFailureCode(acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    }), "UNSUPPORTED_PROFILE");
    await rm(secondLink);

    await truncate(fixture.databasePath, 128 * 1024 * 1024 + 1);
    await expectFailureCode(acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: fixture.databasePath,
      sourceState: "closed-quiescent"
    }), "UNSUPPORTED_PROFILE");
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }

  const symlinkFixture = await sourceFixture({ ".target": "target" });
  try {
    await symlink(
      `${symlinkFixture.databasePath}.target`,
      symlinkFixture.databasePath
    );
    await expectFailureCode(acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: symlinkFixture.databasePath,
      sourceState: "closed-quiescent"
    }), "UNSUPPORTED_PROFILE");
  } finally {
    await rm(symlinkFixture.directory, { force: true, recursive: true });
  }

  const totalFixture = await sourceFixture({
    "": "main",
    "-journal": "journal",
    "-wal": "wal"
  });
  try {
    for (const suffix of ["", "-journal", "-wal"]) {
      await truncate(`${totalFixture.databasePath}${suffix}`, 100 * 1024 * 1024);
    }
    await expectFailureCode(acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: totalFixture.databasePath,
      sourceState: "closed-quiescent"
    }), "UNSUPPORTED_PROFILE");
  } finally {
    await rm(totalFixture.directory, { force: true, recursive: true });
  }
});
