import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupAttuneGraphAdminValidationStaging,
  AttuneGraphAdminStagingLifecycleError,
  openAttuneGraphAdminValidationStaging,
  openAttuneGraphAdminValidationStagingForQualification,
  type AttuneGraphAdminStagingLifecycleFaultForInternalUse,
  type AttuneGraphAdminValidationStagingReceipt
} from "./attunegraph-admin-staging-lifecycle.js";
import type {
  AttuneGraphPortableProjectionIdentity
} from "./attunegraph-portable-encoder.js";

const STORE_ID = `attunegraph-store:${"1".repeat(64)}` as const;
const temporaryDirectories: string[] = [];

function privateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "attunegraph-admin-staging-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return realpathSync.native(directory);
}

function options(directory: string): {
  readonly stagingDirectory: string;
  readonly operationId: string;
} {
  return {
    stagingDirectory: directory,
    operationId: "operation_01"
  };
}

function identity(): AttuneGraphPortableProjectionIdentity {
  return {
    scope: { sourceId: "source", threadId: "thread" },
    generation: 1,
    commitId: "commit-1",
    projectionId: STORE_ID
  };
}

function fault(
  operation: AttuneGraphAdminStagingLifecycleFaultForInternalUse["operation"],
  occurrence = 1,
  beforeOperation?: AttuneGraphAdminStagingLifecycleFaultForInternalUse[
    "beforeOperation"
  ]
): AttuneGraphAdminStagingLifecycleFaultForInternalUse {
  return {
    operation,
    occurrence,
    payload: new Error("qualification fault"),
    beforeOperation
  };
}

async function rejected(operation: () => unknown): Promise<unknown> {
  try {
    await operation();
  } catch (cause) {
    return cause;
  }
  throw new Error("operation did not reject");
}

function receiptFrom(cause: unknown): AttuneGraphAdminValidationStagingReceipt {
  expect(cause).toBeInstanceOf(AttuneGraphAdminStagingLifecycleError);
  const receipt = (cause as AttuneGraphAdminStagingLifecycleError).receipt;
  if (receipt === undefined) throw new Error("missing terminal receipt");
  return receipt;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("package-private AttuneGraph Admin staging filesystem lifecycle", () => {
  it("returns one closed immutable validated database and only explicit cleanup removes it", async () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "sentinel.bin");
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
    const managed = openAttuneGraphAdminValidationStaging(options(directory));
    await managed.sink.appendProjection(identity());
    await managed.sink.sealProjections();
    await managed.sink.assertHead(identity());
    await managed.sink.finish(1, 1);

    const receipt = managed.receipt();
    expect(receipt).toMatchObject({
      state: "closed-validated",
      reasonCode: "VALIDATED"
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.ownedFiles)).toBe(true);
    expect(receipt.ownedFiles).toHaveLength(1);
    const target = receipt.ownedFiles[0]!;
    const stat = lstatSync(target.path, { bigint: true });
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777n).toBe(0o600n);
    expect(stat.dev).toBe(receipt.targetDevice);
    expect(stat.ino).toBe(receipt.targetInode);
    expect(readdirSync(directory).sort()).toEqual([
      "sentinel.bin",
      target.path.slice(directory.length + 1)
    ].sort());

    const cleaned = cleanupAttuneGraphAdminValidationStaging(receipt);
    expect(cleaned).toMatchObject({
      state: "cleanup-complete",
      reasonCode: "ABORTED",
      ownedFiles: []
    });
    expect(readFileSync(sentinel)).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(readdirSync(directory)).toEqual(["sentinel.bin"]);
    expect(cleanupAttuneGraphAdminValidationStaging(cleaned)).toBe(cleaned);
    expect(cleanupAttuneGraphAdminValidationStaging(receipt)).toBe(cleaned);
  });

  it("delegates normal abort and cleans only after observing native close", async () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "unrelated");
    writeFileSync(sentinel, "unchanged", { mode: 0o600 });
    const managed = openAttuneGraphAdminValidationStaging(options(directory));
    await managed.sink.appendProjection(identity());
    await managed.sink.abort(new Error("cancelled"));

    expect(managed.receipt()).toMatchObject({
      state: "cleanup-complete",
      reasonCode: "ABORTED",
      ownedFiles: []
    });
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(readdirSync(directory)).toEqual(["unrelated"]);
  });

  it("rejects hostile options, invalid operation IDs, and non-private directories", () => {
    const directory = privateDirectory();
    const invalid: unknown[] = [
      new Proxy(options(directory), {}),
      { ...options(directory), extra: true },
      { stagingDirectory: ".", operationId: "operation" },
      { stagingDirectory: directory, operationId: "." },
      { stagingDirectory: directory, operationId: "../escape" },
      { stagingDirectory: directory, operationId: "nul\0byte" },
      { stagingDirectory: directory, operationId: "a".repeat(65) }
    ];
    for (const value of invalid) {
      expect(() => openAttuneGraphAdminValidationStaging(value as never))
        .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    }

    chmodSync(directory, 0o755);
    expect(() => openAttuneGraphAdminValidationStaging(options(directory)))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects a symlink component and a noncanonical directory spelling", () => {
    const directory = privateDirectory();
    const child = join(directory, "child");
    const link = join(directory, "link");
    writeFileSync(join(directory, "placeholder"), "");
    symlinkSync(directory, link);
    expect(() => openAttuneGraphAdminValidationStaging(options(link)))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => openAttuneGraphAdminValidationStaging(options(`${directory}/.`)))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => openAttuneGraphAdminValidationStaging(options(child)))
      .toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("fails closed on wrong ownership through a qualification-only uid seam", () => {
    const directory = privateDirectory();
    expect(() => openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("reserve", 99),
      undefined,
      { expectedUid: process.getuid!() + 1 }
    )).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(readdirSync(directory)).toEqual([]);

    const packageJson = JSON.parse(readFileSync(
      join(import.meta.dirname, "../package.json"),
      "utf8"
    )) as { exports: Record<string, unknown> };
    expect(packageJson.exports).not.toHaveProperty(
      "./attunegraph-admin-staging-lifecycle"
    );
  });

  it("never reuses a colliding generated target", () => {
    for (const suffix of ["", "-wal"]) {
      const directory = privateDirectory();
      const failure = (() => {
        try {
          openAttuneGraphAdminValidationStagingForQualification(
            options(directory),
            fault("reserve", 99, (operation, targetPath) => {
              if (operation !== "reserve") return;
              writeFileSync(`${targetPath}${suffix}`, "attacker", {
                mode: 0o600
              });
            })
          );
        } catch (cause) {
          return cause;
        }
        throw new Error("operation did not throw");
      })();
      expect(failure).toMatchObject({ code: "DESTINATION_EXISTS" });
      const files = readdirSync(directory);
      expect(files).toHaveLength(1);
      expect(readFileSync(join(directory, files[0]!), "utf8")).toBe("attacker");
    }
  });

  it("detects inode substitution and leaves a toxic receipt without blind cleanup", () => {
    const directory = privateDirectory();
    const failure = (() => {
      try {
        openAttuneGraphAdminValidationStagingForQualification(
          options(directory),
          fault("post-open-verify", 99, (operation, targetPath) => {
            if (operation !== "post-open-verify") return;
            unlinkSync(targetPath);
            writeFileSync(targetPath, "replacement", { mode: 0o600 });
          })
        );
      } catch (cause) {
        return cause;
      }
      throw new Error("operation did not throw");
    })();
    expect(failure).toMatchObject({
      code: "OPERATION_FAILED",
      receipt: expect.anything()
    });
    const receipt = receiptFrom(failure);
    expect(receipt).toMatchObject({
      state: "toxic-residue",
      reasonCode: "VERIFICATION_FAILED"
    });
    expect(() => cleanupAttuneGraphAdminValidationStaging(receipt))
      .toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    expect(readdirSync(directory)).toHaveLength(1);
  });

  it("does not transfer after a reservation descriptor close failure", () => {
    const directory = privateDirectory();
    const failure = (() => {
      try {
        openAttuneGraphAdminValidationStagingForQualification(
          options(directory),
          fault("reservation-fd-close")
        );
      } catch (cause) {
        return cause;
      }
      throw new Error("operation did not throw");
    })();
    expect(failure).toMatchObject({ code: "OPERATION_FAILED" });
    expect(receiptFrom(failure)).toMatchObject({
      state: "cleanup-complete",
      reasonCode: "OPEN_FAILURE"
    });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("detects permission mutation after reserve and never opens the handle", () => {
    const directory = privateDirectory();
    const failure = (() => {
      try {
        openAttuneGraphAdminValidationStagingForQualification(
          options(directory),
          fault("pre-open-verify", 99, (operation, targetPath) => {
            if (operation === "pre-open-verify") chmodSync(targetPath, 0o644);
          })
        );
      } catch (cause) {
        return cause;
      }
      throw new Error("operation did not throw");
    })();
    expect(receiptFrom(failure)).toMatchObject({
      state: "toxic-residue",
      reasonCode: "VERIFICATION_FAILED"
    });
  });

  it("sanitizes pre-transfer faults and preserves an unrelated sentinel byte-for-byte", () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, Buffer.from("fixed"), { mode: 0o600 });
    const failure = (() => {
      try {
        openAttuneGraphAdminValidationStagingForQualification(
          options(directory),
          fault("transfer")
        );
      } catch (cause) {
        return cause;
      }
      throw new Error("operation did not throw");
    })();
    expect(failure).toMatchObject({
      code: "OPERATION_FAILED",
      message: "admin staging operation failed"
    });
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(receiptFrom(failure)).toMatchObject({
      state: "cleanup-complete",
      reasonCode: "OPEN_FAILURE"
    });
    expect(readFileSync(sentinel)).toEqual(Buffer.from("fixed"));
    expect(readdirSync(directory)).toEqual(["sentinel"]);
  });

  it("settles reserve and pre-transfer verification fault families deterministically", () => {
    const cases = [
      { operation: "reserve", receiptState: undefined },
      { operation: "pre-open-verify", receiptState: "cleanup-complete" },
      { operation: "post-open-verify", receiptState: "cleanup-complete" }
    ] as const;
    for (const row of cases) {
      const directory = privateDirectory();
      const sentinel = join(directory, "sentinel");
      writeFileSync(sentinel, row.operation, { mode: 0o600 });
      const failure = (() => {
        try {
          openAttuneGraphAdminValidationStagingForQualification(
            options(directory),
            fault(row.operation)
          );
        } catch (cause) {
          return cause;
        }
        throw new Error("operation did not throw");
      })();
      expect(failure).toMatchObject({
        code: "OPERATION_FAILED",
        message: "admin staging operation failed"
      });
      if (row.receiptState === undefined) {
        expect((failure as AttuneGraphAdminStagingLifecycleError).receipt)
          .toBeUndefined();
      } else {
        expect(receiptFrom(failure).state).toBe(row.receiptState);
      }
      expect(readFileSync(sentinel, "utf8")).toBe(row.operation);
      expect(readdirSync(directory)).toEqual(["sentinel"]);
    }
  });

  it("treats a4c commit failure as unpublished toxic ambiguity", async () => {
    const directory = privateDirectory();
    const managed = openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("transfer", 99),
      {
        operation: "commit",
        payload: new Error("raw sqlite path must not escape"),
        runtimeOnly: true
      }
    );
    await managed.sink.appendProjection(identity());
    await managed.sink.sealProjections();
    await managed.sink.assertHead(identity());
    const failure = await rejected(() => managed.sink.finish(1, 1));

    expect(failure).toMatchObject({
      code: "OPERATION_FAILED",
      message: "admin staging operation failed"
    });
    expect(receiptFrom(failure)).toMatchObject({
      state: "toxic-residue",
      reasonCode: "COMMIT_CLOSE_AMBIGUITY"
    });
    expect(() => cleanupAttuneGraphAdminValidationStaging(managed.receipt()))
      .toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
  });

  it("never reports cleanup-complete when a4c abort leaves its handle open", async () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, Buffer.from([7, 0, 7]), { mode: 0o600 });
    let targetPath = "";
    const cleanupOperations = {
      discovery: 0,
      unlink: 0,
      fsync: 0
    };
    const managed = openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("transfer", 99, (operation, path) => {
        if (operation === "reserve") targetPath = path;
        if (operation === "sidecar-discovery") {
          cleanupOperations.discovery += 1;
        }
        if (operation === "unlink") cleanupOperations.unlink += 1;
        if (operation === "parent-fsync") cleanupOperations.fsync += 1;
      }),
      {
        operation: "close",
        payload: new Error("qualification close failure"),
        runtimeOnly: true
      }
    );

    const failure = await rejected(() => managed.sink.abort("cancel"));
    expect(failure).toMatchObject({
      code: "OPERATION_FAILED",
      message: "admin staging operation failed"
    });
    const receipt = receiptFrom(failure);
    expect(receipt).toMatchObject({
      state: "toxic-residue",
      reasonCode: "CLOSE_AMBIGUITY"
    });
    expect(receipt.ownedFiles).toEqual([expect.objectContaining({
      path: targetPath,
      device: receipt.targetDevice,
      inode: receipt.targetInode
    })]);
    expect(readFileSync(sentinel)).toEqual(Buffer.from([7, 0, 7]));
    expect(cleanupOperations).toEqual({
      discovery: 0,
      unlink: 0,
      fsync: 0
    });
    expect(readdirSync(directory).sort()).toEqual([
      "sentinel",
      targetPath.slice(directory.length + 1)
    ].sort());
  });

  it("preserves close-fault pre-commit residue without filesystem cleanup", async () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, "fixed", { mode: 0o600 });
    let targetPath = "";
    const cleanupOperations = {
      discovery: 0,
      unlink: 0,
      fsync: 0
    };
    const managed = openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("transfer", 99, (operation, path) => {
        if (operation === "reserve") targetPath = path;
        if (operation === "sidecar-discovery") {
          cleanupOperations.discovery += 1;
        }
        if (operation === "unlink") cleanupOperations.unlink += 1;
        if (operation === "parent-fsync") cleanupOperations.fsync += 1;
      }),
      {
        operation: "close",
        payload: new Error("qualification close failure"),
        runtimeOnly: true
      }
    );

    const failure = await rejected(() => managed.sink.appendProjection({
      ...identity(),
      generation: 2
    }));
    expect(failure).toMatchObject({ code: "OPERATION_FAILED" });
    expect(receiptFrom(failure)).toMatchObject({
      state: "toxic-residue",
      reasonCode: "CLOSE_AMBIGUITY",
      ownedFiles: [expect.objectContaining({ path: targetPath })]
    });
    expect(cleanupOperations).toEqual({
      discovery: 0,
      unlink: 0,
      fsync: 0
    });
    expect(readFileSync(sentinel, "utf8")).toBe("fixed");
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it("retains every verified expected sidecar in post-close toxic residue", async () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, "same", { mode: 0o600 });
    let walPath = "";
    const managed = openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("post-close-verify", 99, (operation, targetPath) => {
        if (operation !== "post-close-verify") return;
        walPath = `${targetPath}-wal`;
        writeFileSync(walPath, "owned-wal", { mode: 0o600 });
      })
    );
    await managed.sink.appendProjection(identity());
    await managed.sink.sealProjections();
    await managed.sink.assertHead(identity());

    const failure = await rejected(() => managed.sink.finish(1, 1));
    const receipt = receiptFrom(failure);
    expect(receipt).toMatchObject({
      state: "toxic-residue",
      reasonCode: "VERIFICATION_FAILED"
    });
    expect(receipt.ownedFiles.map((file) => file.path).sort()).toEqual([
      walPath.slice(0, -4),
      walPath
    ].sort());
    expect(readFileSync(walPath, "utf8")).toBe("owned-wal");
    expect(readFileSync(sentinel, "utf8")).toBe("same");
  });

  it("excludes deleted and substituted files but retains the untouched cleanup tail", () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, Buffer.from("immutable"), { mode: 0o600 });
    let targetPath = "";
    let walPath = "";
    let shmPath = "";
    let shmIdentity:
      | { readonly device: bigint; readonly inode: bigint }
      | undefined;
    let unlinkCount = 0;
    const failure = (() => {
      try {
        openAttuneGraphAdminValidationStagingForQualification(
          options(directory),
          fault("transfer", 1, (operation, path) => {
            targetPath = path;
            if (operation === "transfer") {
              walPath = `${path}-wal`;
              shmPath = `${path}-shm`;
              writeFileSync(walPath, "owned-wal", { mode: 0o600 });
              writeFileSync(shmPath, "owned-shm", { mode: 0o600 });
              const stat = lstatSync(shmPath, { bigint: true });
              shmIdentity = { device: stat.dev, inode: stat.ino };
            }
            if (operation === "unlink") {
              unlinkCount += 1;
              if (unlinkCount === 2) {
                unlinkSync(walPath);
                writeFileSync(walPath, "replacement", { mode: 0o600 });
              }
            }
          })
        );
      } catch (cause) {
        return cause;
      }
      throw new Error("operation did not throw");
    })();

    const receipt = receiptFrom(failure);
    expect(receipt).toMatchObject({
      state: "toxic-residue",
      reasonCode: "IDENTITY_MISMATCH"
    });
    expect(receipt.ownedFiles).toEqual([{
      path: shmPath,
      device: shmIdentity!.device,
      inode: shmIdentity!.inode
    }]);
    expect(() => lstatSync(targetPath)).toThrow();
    expect(readFileSync(walPath, "utf8")).toBe("replacement");
    expect(readFileSync(shmPath, "utf8")).toBe("owned-shm");
    expect(readFileSync(sentinel)).toEqual(Buffer.from("immutable"));
  });

  it("cleans a deterministic pre-commit failure after observing native close", async () => {
    const directory = privateDirectory();
    const managed = openAttuneGraphAdminValidationStaging(options(directory));
    const failure = await rejected(() => managed.sink.appendProjection({
      ...identity(),
      generation: 2
    }));
    expect(failure).toMatchObject({ code: "OPERATION_FAILED" });
    expect(receiptFrom(failure)).toMatchObject({
      state: "cleanup-complete",
      reasonCode: "PRE_COMMIT_FAILURE",
      ownedFiles: []
    });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("cleans a deterministic generation gap after observing native close", async () => {
    const directory = privateDirectory();
    const managed = openAttuneGraphAdminValidationStaging(options(directory));
    await managed.sink.appendProjection(identity());
    const failure = await rejected(() => managed.sink.appendProjection({
      ...identity(),
      generation: 3,
      commitId: "commit-3"
    }));
    expect(failure).toMatchObject({ code: "OPERATION_FAILED" });
    expect(receiptFrom(failure)).toMatchObject({
      state: "cleanup-complete",
      reasonCode: "PRE_COMMIT_FAILURE",
      ownedFiles: []
    });
    expect(readdirSync(directory)).toEqual([]);
  });

  it("makes post-close verification and discovery faults toxic without deletion", async () => {
    {
      const directory = privateDirectory();
      const managed = openAttuneGraphAdminValidationStagingForQualification(
        options(directory),
        fault("post-close-verify")
      );
      await managed.sink.appendProjection(identity());
      await managed.sink.sealProjections();
      await managed.sink.assertHead(identity());
      const failure = await rejected(() => managed.sink.finish(1, 1));
      expect(receiptFrom(failure)).toMatchObject({
        state: "toxic-residue",
        reasonCode: "VERIFICATION_FAILED"
      });
      expect(readdirSync(directory)).toHaveLength(1);
    }
    {
      const directory = privateDirectory();
      const failure = (() => {
        try {
          openAttuneGraphAdminValidationStagingForQualification(
            options(directory),
            fault("sidecar-discovery", 1, (operation) => {
              if (operation === "transfer") {
                throw new Error("pre-transfer failure");
              }
            })
          );
        } catch (cause) {
          return cause;
        }
        throw new Error("operation did not throw");
      })();
      expect(receiptFrom(failure)).toMatchObject({
        state: "toxic-residue",
        reasonCode: "VERIFICATION_FAILED"
      });
      expect(readdirSync(directory)).toHaveLength(1);
    }
  });

  it("records partial unlink failure and explicit cleanup retries only its exact inode", async () => {
    const directory = privateDirectory();
    const sentinel = join(directory, "sentinel");
    writeFileSync(sentinel, "same", { mode: 0o600 });
    const managed = openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("unlink")
    );
    await managed.sink.sealProjections();
    await managed.sink.finish(0, 0);
    const validated = managed.receipt();
    const failure = (() => {
      try {
        cleanupAttuneGraphAdminValidationStaging(validated);
      } catch (cause) {
        return cause;
      }
      throw new Error("cleanup did not throw");
    })();
    expect(failure).toMatchObject({ code: "CLEANUP_PENDING" });
    const pending = receiptFrom(failure);
    expect(pending).toMatchObject({
      state: "cleanup-pending",
      reasonCode: "CLEANUP_FAILED"
    });
    expect(pending.ownedFiles).toHaveLength(1);

    const complete = cleanupAttuneGraphAdminValidationStaging(pending);
    expect(complete.state).toBe("cleanup-complete");
    expect(readFileSync(sentinel, "utf8")).toBe("same");
    expect(readdirSync(directory)).toEqual(["sentinel"]);
  });

  it("requires parent fsync before cleanup-complete and can retry only that durability step", async () => {
    const directory = privateDirectory();
    const managed = openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("parent-fsync")
    );
    await managed.sink.sealProjections();
    await managed.sink.finish(0, 0);
    const validated = managed.receipt();
    const failure = (() => {
      try {
        cleanupAttuneGraphAdminValidationStaging(validated);
      } catch (cause) {
        return cause;
      }
      throw new Error("cleanup did not throw");
    })();
    const pending = receiptFrom(failure);
    expect(pending).toMatchObject({
      state: "cleanup-pending",
      reasonCode: "CLEANUP_FAILED",
      ownedFiles: []
    });
    expect(readdirSync(directory)).toEqual([]);

    const complete = cleanupAttuneGraphAdminValidationStaging(pending);
    expect(complete).toMatchObject({
      state: "cleanup-complete",
      ownedFiles: []
    });
  });

  it("does not broaden cleanup for an unexpected target-prefix artifact", async () => {
    const directory = privateDirectory();
    let roguePath = "";
    const managed = openAttuneGraphAdminValidationStagingForQualification(
      options(directory),
      fault("sidecar-discovery", 99, (operation, targetPath) => {
        if (operation !== "sidecar-discovery") return;
        roguePath = `${targetPath}-rogue`;
        writeFileSync(roguePath, "rogue", { mode: 0o600 });
      })
    );
    await managed.sink.sealProjections();
    const failure = await rejected(() => managed.sink.finish(0, 0));
    const receipt = receiptFrom(failure);
    expect(receipt).toMatchObject({
      state: "toxic-residue",
      reasonCode: "UNEXPECTED_ARTIFACT"
    });
    expect(readFileSync(roguePath, "utf8")).toBe("rogue");
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it("rejects nonterminal access, duplicate terminal settlement, and hostile receipts", async () => {
    const directory = privateDirectory();
    const managed = openAttuneGraphAdminValidationStaging(options(directory));
    expect(() => managed.receipt())
      .toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    await managed.sink.abort("cancel");
    const receipt = managed.receipt();
    await expect(managed.sink.abort("again"))
      .rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(() => cleanupAttuneGraphAdminValidationStaging({
      ...receipt
    })).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => cleanupAttuneGraphAdminValidationStaging(
      new Proxy(receipt, {})
    )).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("fails managed-sink transfer reentry without duplicating a4c calls", async () => {
    const directory = privateDirectory();
    const managed = openAttuneGraphAdminValidationStaging(options(directory));
    const first = managed.sink.appendProjection(identity());
    await expect(managed.sink.sealProjections())
      .rejects.toMatchObject({ code: "INVALID_STATE" });
    await first;
    await managed.sink.abort("cancel");
    expect(managed.receipt().state).toBe("cleanup-complete");
  });
});
