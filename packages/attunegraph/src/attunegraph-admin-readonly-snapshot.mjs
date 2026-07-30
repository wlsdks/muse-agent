import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rmdir,
  statfs,
  unlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import process from "node:process";
import { types as nodeTypes } from "node:util";

const isProxy = nodeTypes.isProxy;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;

/** @type {readonly [string, string, string, string]} */
const SOURCE_SUFFIXES = objectFreeze(["", "-journal", "-wal", "-shm"]);
/** @type {readonly [string, string, string, string]} */
const COPY_NAMES = objectFreeze([
  "store.sqlite",
  "store.sqlite-journal",
  "store.sqlite-wal",
  "store.sqlite-shm"
]);
/** @type {readonly [SnapshotQualificationFault, SnapshotQualificationFault, SnapshotQualificationFault, SnapshotQualificationFault]} */
const DATA_INTERRUPT_FAULTS = objectFreeze([
  "interrupt-after-main-unlink",
  "interrupt-after-journal-unlink",
  "interrupt-after-wal-unlink",
  "interrupt-after-shm-unlink"
]);
const MARKER_NAME = ".attunegraph-admin-lease-v1.json";
const MAX_PATH_BYTES = 4_096;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const DEADLINE_MS = 30_000;
const ALLOWED_FAULTS = objectFreeze([
  "wrong-owner-profile",
  "cross-device-sidecar-profile",
  "unsupported-temp-filesystem-profile",
  "source-change-before-final-check",
  "deadline-after-first-read",
  "source-read-failure",
  "source-hash-failure",
  "temp-directory-failure",
  "temp-child-chmod-failure",
  "temp-child-open-failure",
  "temp-child-stat-failure",
  "temp-child-profile-failure",
  "copy-write-failure",
  "marker-write-failure",
  "interrupt-after-main-unlink",
  "interrupt-after-journal-unlink",
  "interrupt-after-wal-unlink",
  "interrupt-after-shm-unlink",
  "interrupt-after-marker-unlink",
  "interrupt-before-directory-remove",
  "cleanup-failure-after-primary",
  "cleanup-first-failure"
]);

/** @typedef {"SOURCE_NOT_FOUND" | "UNSUPPORTED_PROFILE" | "STORE_BUSY" | "WORKER_FAILURE"} SnapshotFailureCode */
/** @typedef {"wrong-owner-profile" | "cross-device-sidecar-profile" | "unsupported-temp-filesystem-profile" | "source-change-before-final-check" | "deadline-after-first-read" | "source-read-failure" | "source-hash-failure" | "temp-directory-failure" | "temp-child-chmod-failure" | "temp-child-open-failure" | "temp-child-stat-failure" | "temp-child-profile-failure" | "copy-write-failure" | "marker-write-failure" | "interrupt-after-main-unlink" | "interrupt-after-journal-unlink" | "interrupt-after-wal-unlink" | "interrupt-after-shm-unlink" | "interrupt-after-marker-unlink" | "interrupt-before-directory-remove" | "cleanup-failure-after-primary" | "cleanup-first-failure"} SnapshotQualificationFault */
/** @typedef {Readonly<{dev: bigint, ino: bigint, uid: number, type: "regular", mode: number, nlink: number}>} SnapshotIdentity */
/** @typedef {Readonly<{state: "absent"}> | Readonly<{state: "present", identity: SnapshotIdentity, size: number, mtimeNs: bigint, sha256: string}>} SnapshotManifestEntry */
/** @typedef {Readonly<{main: SnapshotManifestEntry, "-journal": SnapshotManifestEntry, "-wal": SnapshotManifestEntry, "-shm": SnapshotManifestEntry}>} SnapshotManifest */
/** @typedef {Readonly<{primaryCode?: SnapshotFailureCode, cleanupAttempts: number, cleanupFailures: number, cleanupInterruptions: number, dataPhaseBits: number, markerPhase: 0 | 1, directoryPhase: 0 | 1, sourceFdsOpened: number, sourceFdsClosed: number, copyFdsOpened: number, copyFdsClosed: number, directoryFdClosed: 0 | 1, terminalAuditSettlements: 1, trace: readonly string[]}>} SnapshotQualificationAudit */

const failureMessages = objectFreeze({
  SOURCE_NOT_FOUND: "Admin snapshot source was not found",
  UNSUPPORTED_PROFILE: "Admin snapshot profile is unsupported",
  STORE_BUSY: "Admin snapshot source changed",
  WORKER_FAILURE: "Admin snapshot operation failed"
});
/** @type {WeakMap<object, SnapshotFailureCode>} */
const failureBrands = new WeakMap();

class SnapshotFailure extends Error {
  /** @param {SnapshotFailureCode} code */
  constructor(code) {
    super(failureMessages[code]);
    this.name = "AttuneGraphAdminReadonlySnapshotFailure";
    Object.defineProperty(this, "stack", {
      configurable: false,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: false
    });
    failureBrands.set(this, code);
    objectFreeze(this);
  }
}

/** @param {SnapshotFailureCode} code @returns {SnapshotFailure} */
function snapshotFailure(code) {
  return new SnapshotFailure(code);
}

/** @param {SnapshotFailureCode} code @returns {never} */
function failSnapshot(code) {
  throw snapshotFailure(code);
}

/** @param {unknown} value @returns {SnapshotFailureCode | undefined} */
export function readAttuneGraphAdminReadonlySnapshotFailure(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  return failureBrands.get(value);
}

/** @param {unknown} value @returns {string | undefined} */
function safeErrorCode(value) {
  if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
  const descriptor = objectGetOwnPropertyDescriptor(value, "code");
  return descriptor !== undefined
    && Object.hasOwn(descriptor, "value")
    && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

/** @param {unknown} cause @returns {never} */
function rethrowBrandedOrWorkerFailure(cause) {
  if (readAttuneGraphAdminReadonlySnapshotFailure(cause) !== undefined) throw cause;
  failSnapshot("WORKER_FAILURE");
}

/**
 * @param {unknown} value
 * @param {boolean} qualification
 * @returns {Readonly<{databasePath: string, sourceState: "closed-quiescent", fault?: SnapshotQualificationFault}>}
 */
function admitOptions(value, qualification) {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
    || Array.isArray(value)
  ) failSnapshot("UNSUPPORTED_PROFILE");
  const prototype = reflectGetPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failSnapshot("UNSUPPORTED_PROFILE");
  }
  const allowed = qualification
    ? ["databasePath", "sourceState", "fault"]
    : ["databasePath", "sourceState"];
  const required = ["databasePath", "sourceState"];
  const keys = reflectOwnKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) failSnapshot("UNSUPPORTED_PROFILE");
  /** @type {Record<string, unknown>} */
  const detached = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") failSnapshot("UNSUPPORTED_PROFILE");
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) failSnapshot("UNSUPPORTED_PROFILE");
    detached[key] = descriptor.value;
  }
  if (
    typeof detached.databasePath !== "string"
    || detached.sourceState !== "closed-quiescent"
    || (
      qualification
      && detached.fault !== undefined
      && (
        typeof detached.fault !== "string"
        || !ALLOWED_FAULTS.includes(
          /** @type {SnapshotQualificationFault} */ (detached.fault)
        )
      )
    )
  ) failSnapshot("UNSUPPORTED_PROFILE");
  return objectFreeze({
    databasePath: detached.databasePath,
    sourceState: "closed-quiescent",
    fault: qualification
      ? /** @type {SnapshotQualificationFault | undefined} */ (detached.fault)
      : undefined
  });
}

/** @param {string} path */
function admitPath(path) {
  if (
    !isAbsolute(path)
    || normalize(path) !== path
    || path.includes("\0")
    || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES
  ) failSnapshot("UNSUPPORTED_PROFILE");
}

/** @returns {number} */
function expectedUid() {
  if (
    (process.platform !== "darwin" && process.platform !== "linux")
    || typeof process.geteuid !== "function"
  ) failSnapshot("UNSUPPORTED_PROFILE");
  return process.geteuid();
}

/** @returns {ReadonlySet<bigint>} */
function allowedFilesystemTypes() {
  if (process.platform === "darwin") {
    return new Set([0x11n, 0x1an]);
  }
  if (process.platform === "linux") {
    return new Set([
      0xef53n,
      0x58465342n,
      0x9123683en,
      0x794c7630n,
      0x01021994n
    ]);
  }
  failSnapshot("UNSUPPORTED_PROFILE");
}

/** @param {string} path @param {SnapshotQualificationFault | undefined} fault */
async function admitFilesystem(path, fault) {
  let profile;
  try {
    profile = await statfs(path, { bigint: true });
  } catch (cause) {
    return rethrowBrandedOrWorkerFailure(cause);
  }
  const type = fault === "unsupported-temp-filesystem-profile"
    ? -1n
    : profile.type;
  if (!allowedFilesystemTypes().has(type)) failSnapshot("UNSUPPORTED_PROFILE");
  return profile;
}

/** @param {import("node:fs").BigIntStats} stats */
function modeBits(stats) {
  return Number(stats.mode & 0o777n);
}

/** @param {import("node:fs").BigIntStats} stats @returns {SnapshotIdentity} */
function fileIdentity(stats) {
  return objectFreeze({
    dev: stats.dev,
    ino: stats.ino,
    uid: Number(stats.uid),
    type: "regular",
    mode: modeBits(stats),
    nlink: Number(stats.nlink)
  });
}

/**
 * @param {import("node:fs").BigIntStats} left
 * @param {import("node:fs").BigIntStats} right
 * @param {boolean} [withContentMetadata]
 */
function sameFile(left, right, withContentMetadata = true) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.isFile() === right.isFile()
    && (!withContentMetadata || (
      left.size === right.size
      && left.mtimeNs === right.mtimeNs
    ))
  );
}

/**
 * @param {import("node:fs").BigIntStats} left
 * @param {import("node:fs").BigIntStats} right
 */
function sameDirectory(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.isDirectory()
    && right.isDirectory()
  );
}

/**
 * @param {import("node:fs").BigIntStats} stats
 * @param {number} uid
 * @param {bigint | undefined} device
 */
function admitRegularFile(stats, uid, device) {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || Number(stats.uid) !== uid
    || modeBits(stats) !== 0o600
    || stats.nlink !== 1n
    || (device !== undefined && stats.dev !== device)
    || stats.size > BigInt(MAX_ENTRY_BYTES)
  ) failSnapshot("UNSUPPORTED_PROFILE");
}

/**
 * @param {string} path
 * @param {"initial-main" | "initial-sidecar" | "final"} phase
 * @returns {Promise<import("node:fs").BigIntStats | undefined>}
 */
async function pathStats(path, phase) {
  try {
    return await lstat(path, { bigint: true });
  } catch (cause) {
    if (safeErrorCode(cause) === "ENOENT") {
      if (phase === "initial-main") failSnapshot("SOURCE_NOT_FOUND");
      return undefined;
    }
    if (phase === "final") failSnapshot("STORE_BUSY");
    return rethrowBrandedOrWorkerFailure(cause);
  }
}

/** @param {SnapshotQualificationFault | undefined} fault */
function createAuditContext(fault) {
  /** @type {(audit: SnapshotQualificationAudit) => void} */
  let resolveAudit = () => undefined;
  const terminalAudit = new Promise((resolve) => {
    resolveAudit = resolve;
  });
  return {
    fault,
    faultConsumed: false,
    forcedDeadline: false,
    primaryCode: /** @type {SnapshotFailureCode | undefined} */ (undefined),
    cleanupAttempts: 0,
    cleanupFailures: 0,
    cleanupInterruptions: 0,
    dataPhaseBits: 0,
    markerPhase: /** @type {0 | 1} */ (0),
    directoryPhase: /** @type {0 | 1} */ (0),
    sourceFdsOpened: 0,
    sourceFdsClosed: 0,
    copyFdsOpened: 0,
    copyFdsClosed: 0,
    directoryFdClosed: /** @type {0 | 1} */ (0),
    closeFailure: false,
    trace: /** @type {string[]} */ ([]),
    settled: false,
    resolveAudit,
    terminalAudit
  };
}

/** @param {ReturnType<typeof createAuditContext>} audit */
function settleAudit(audit) {
  if (audit.settled) return;
  audit.settled = true;
  audit.resolveAudit(objectFreeze({
    ...(audit.primaryCode === undefined ? {} : { primaryCode: audit.primaryCode }),
    cleanupAttempts: audit.cleanupAttempts,
    cleanupFailures: audit.cleanupFailures,
    cleanupInterruptions: audit.cleanupInterruptions,
    dataPhaseBits: audit.dataPhaseBits,
    markerPhase: audit.markerPhase,
    directoryPhase: audit.directoryPhase,
    sourceFdsOpened: audit.sourceFdsOpened,
    sourceFdsClosed: audit.sourceFdsClosed,
    copyFdsOpened: audit.copyFdsOpened,
    copyFdsClosed: audit.copyFdsClosed,
    directoryFdClosed: audit.directoryFdClosed,
    terminalAuditSettlements: 1,
    trace: objectFreeze(audit.trace.slice())
  }));
}

/**
 * @param {ReturnType<typeof createAuditContext>} audit
 * @param {SnapshotQualificationFault} fault
 */
function consumeFault(audit, fault) {
  if (!audit.faultConsumed && audit.fault === fault) {
    audit.faultConsumed = true;
    return true;
  }
  return false;
}

/**
 * @param {ReturnType<typeof createAuditContext>} audit
 * @param {number} startedAt
 */
function checkDeadline(audit, startedAt) {
  if (audit.forcedDeadline || Date.now() - startedAt >= DEADLINE_MS) {
    failSnapshot("STORE_BUSY");
  }
}

/**
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {ReturnType<typeof createAuditContext>} audit
 */
async function closeSource(handle, audit) {
  try {
    await handle.close();
  } catch {
    audit.closeFailure = true;
  } finally {
    audit.sourceFdsClosed += 1;
  }
}

/**
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {ReturnType<typeof createAuditContext>} audit
 */
async function closeCopy(handle, audit) {
  try {
    await handle.close();
  } catch {
    audit.closeFailure = true;
  } finally {
    audit.copyFdsClosed += 1;
  }
}

/**
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {Buffer} buffer
 * @param {number} length
 * @param {ReturnType<typeof createAuditContext>} audit
 * @param {number} startedAt
 */
async function writeChunk(handle, buffer, length, audit, startedAt) {
  let offset = 0;
  while (offset < length) {
    checkDeadline(audit, startedAt);
    if (consumeFault(audit, "copy-write-failure")) {
      throw Object.assign(new Error("copy write failed"), { code: "EIO" });
    }
    const result = await handle.write(buffer, offset, length - offset, null);
    if (result.bytesWritten <= 0) throw new Error("copy write made no progress");
    offset += result.bytesWritten;
    checkDeadline(audit, startedAt);
  }
}

/**
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {string} content
 * @param {ReturnType<typeof createAuditContext>} audit
 * @param {number} startedAt
 */
async function writeMarker(handle, content, audit, startedAt) {
  const bytes = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    checkDeadline(audit, startedAt);
    if (consumeFault(audit, "marker-write-failure")) {
      throw Object.assign(new Error("marker write failed"), { code: "EIO" });
    }
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (result.bytesWritten <= 0) throw new Error("marker write made no progress");
    offset += result.bytesWritten;
    checkDeadline(audit, startedAt);
  }
}

/**
 * @param {string} destinationPath
 * @param {number} uid
 * @param {bigint} destinationDevice
 * @param {number} expectedCount
 * @param {string} expectedDigest
 * @param {ReturnType<typeof createAuditContext>} audit
 * @param {number} startedAt
 */
async function verifyCompletedCopy(
  destinationPath,
  uid,
  destinationDevice,
  expectedCount,
  expectedDigest,
  audit,
  startedAt
) {
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let completed;
  try {
    completed = await open(
      destinationPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    );
    audit.copyFdsOpened += 1;
    const before = await completed.stat({ bigint: true });
    admitRegularFile(before, uid, destinationDevice);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let count = 0;
    for (;;) {
      checkDeadline(audit, startedAt);
      const result = await completed.read(buffer, 0, buffer.length, null);
      checkDeadline(audit, startedAt);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await completed.stat({ bigint: true });
    const pathState = await lstat(destinationPath, { bigint: true });
    if (
      count !== expectedCount
      || hash.digest("hex") !== expectedDigest
      || !sameFile(before, after)
      || !sameFile(before, pathState)
    ) failSnapshot("WORKER_FAILURE");
    return after;
  } catch (cause) {
    return rethrowBrandedOrWorkerFailure(cause);
  } finally {
    if (completed !== undefined) await closeCopy(completed, audit);
  }
}

/**
 * @param {string} sourcePath
 * @param {string} destinationPath
 * @param {import("node:fs").BigIntStats} initialStats
 * @param {number} uid
 * @param {bigint} destinationDevice
 * @param {ReturnType<typeof createAuditContext>} audit
 * @param {number} startedAt
 */
async function copyEntry(
  sourcePath,
  destinationPath,
  initialStats,
  uid,
  destinationDevice,
  audit,
  startedAt
) {
  checkDeadline(audit, startedAt);
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let source;
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let destination;
  try {
    try {
      source = await open(
        sourcePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      );
    } catch (cause) {
      if (safeErrorCode(cause) === "ENOENT" || safeErrorCode(cause) === "ELOOP") {
        failSnapshot("STORE_BUSY");
      }
      return rethrowBrandedOrWorkerFailure(cause);
    }
    audit.sourceFdsOpened += 1;
    const openedStats = await source.stat({ bigint: true });
    if (!sameFile(initialStats, openedStats)) failSnapshot("STORE_BUSY");
    destination = await open(
      destinationPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o600
    );
    audit.copyFdsOpened += 1;
    await destination.chmod(0o600);
    const sourceHash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let count = 0;
    for (;;) {
      checkDeadline(audit, startedAt);
      if (consumeFault(audit, "source-read-failure")) {
        throw Object.assign(new Error("source read failed"), { code: "EIO" });
      }
      const result = await source.read(buffer, 0, buffer.length, null);
      checkDeadline(audit, startedAt);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
      sourceHash.update(buffer.subarray(0, result.bytesRead));
      if (consumeFault(audit, "deadline-after-first-read")) {
        audit.forcedDeadline = true;
      }
      if (
        audit.fault === "cleanup-failure-after-primary"
        && !audit.forcedDeadline
      ) {
        audit.forcedDeadline = true;
      }
      await writeChunk(destination, buffer, result.bytesRead, audit, startedAt);
    }
    if (consumeFault(audit, "source-hash-failure")) {
      throw new Error("source hash failed");
    }
    const sourceDigest = sourceHash.digest("hex");
    if (count !== Number(initialStats.size)) failSnapshot("STORE_BUSY");
    const afterStats = await source.stat({ bigint: true });
    if (!sameFile(initialStats, afterStats)) failSnapshot("STORE_BUSY");
    const destinationStats = await destination.stat({ bigint: true });
    admitRegularFile(destinationStats, uid, destinationDevice);
    if (destinationStats.size !== BigInt(count)) failSnapshot("WORKER_FAILURE");
    const destinationPathStats = await lstat(destinationPath, { bigint: true });
    if (!sameFile(destinationStats, destinationPathStats)) {
      failSnapshot("WORKER_FAILURE");
    }
    await closeCopy(destination, audit);
    destination = undefined;
    if (audit.closeFailure) failSnapshot("WORKER_FAILURE");
    const completedStats = await verifyCompletedCopy(
      destinationPath,
      uid,
      destinationDevice,
      count,
      sourceDigest,
      audit,
      startedAt
    );
    return objectFreeze({
      manifest: objectFreeze({
        state: "present",
        identity: fileIdentity(initialStats),
        size: count,
        mtimeNs: initialStats.mtimeNs,
        sha256: sourceDigest
      }),
      destinationStats: completedStats
    });
  } catch (cause) {
    return rethrowBrandedOrWorkerFailure(cause);
  } finally {
    if (destination !== undefined) await closeCopy(destination, audit);
    if (source !== undefined) await closeSource(source, audit);
  }
}

/**
 * @param {string} sourcePath
 * @param {ReturnType<typeof createAuditContext>} audit
 * @param {number} startedAt
 */
async function hashSource(sourcePath, audit, startedAt) {
  /** @type {import("node:fs/promises").FileHandle | undefined} */
  let source;
  try {
    try {
      source = await open(
        sourcePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      );
    } catch (cause) {
      if (safeErrorCode(cause) === "ENOENT" || safeErrorCode(cause) === "ELOOP") {
        failSnapshot("STORE_BUSY");
      }
      return rethrowBrandedOrWorkerFailure(cause);
    }
    audit.sourceFdsOpened += 1;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    for (;;) {
      checkDeadline(audit, startedAt);
      const result = await source.read(buffer, 0, buffer.length, null);
      checkDeadline(audit, startedAt);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    return hash.digest("hex");
  } catch (cause) {
    return rethrowBrandedOrWorkerFailure(cause);
  } finally {
    if (source !== undefined) await closeSource(source, audit);
  }
}

/** @type {WeakMap<object, LeaseState>} */
const leaseStates = new WeakMap();

/**
 * @typedef {{
 *   readonly directoryPath: string,
 *   directoryHandle?: import("node:fs/promises").FileHandle,
 *   directoryStats?: import("node:fs").BigIntStats,
 *   readonly audit: ReturnType<typeof createAuditContext>,
 *   directoryHandleClosed: boolean
 * }} ConstructionCleanupState
 */

/**
 * @typedef {{
 *   readonly directoryPath: string,
 *   readonly directoryHandle: import("node:fs/promises").FileHandle,
 *   readonly directoryStats: import("node:fs").BigIntStats,
 *   markerStats?: import("node:fs").BigIntStats,
 *   readonly entryStats: Map<string, import("node:fs").BigIntStats>,
 *   readonly audit: ReturnType<typeof createAuditContext>,
 *   releasePromise?: Promise<void>,
 *   directoryHandleClosed: boolean
 * }} LeaseState
 */

/** @param {ConstructionCleanupState} state */
async function closeConstructionDirectoryHandle(state) {
  if (state.directoryHandle === undefined || state.directoryHandleClosed) return;
  state.directoryHandleClosed = true;
  try {
    await state.directoryHandle.close();
  } finally {
    state.audit.directoryFdClosed = 1;
  }
}

/** @param {ConstructionCleanupState} state */
async function cleanupConstructionState(state) {
  state.audit.cleanupAttempts += 1;
  state.audit.trace.push("construction-cleanup-start");
  try {
    const descriptorStats = state.directoryHandle === undefined
      ? undefined
      : await state.directoryHandle.stat({ bigint: true });
    let pathStatsValue;
    try {
      pathStatsValue = await lstat(state.directoryPath, { bigint: true });
    } catch (cause) {
      if (safeErrorCode(cause) !== "ENOENT") throw cause;
    }
    if (pathStatsValue !== undefined) {
      if (
        !pathStatsValue.isDirectory()
        || pathStatsValue.isSymbolicLink()
        || (
          descriptorStats !== undefined
          && !sameDirectory(descriptorStats, pathStatsValue)
        )
        || (
          state.directoryStats !== undefined
          && !sameDirectory(state.directoryStats, pathStatsValue)
        )
      ) failSnapshot("WORKER_FAILURE");
      const entries = await readdir(state.directoryPath);
      if (entries.length !== 0) failSnapshot("WORKER_FAILURE");
      await rmdir(state.directoryPath);
    }
    state.audit.directoryPhase = 1;
    state.audit.trace.push("construction-cleanup-removed");
    await closeConstructionDirectoryHandle(state);
  } catch {
    state.audit.cleanupFailures += 1;
    state.audit.trace.push("construction-cleanup-quarantined");
    try {
      await closeConstructionDirectoryHandle(state);
    } catch {
    }
  }
  settleAudit(state.audit);
}

/** @param {LeaseState} state */
async function validateCleanupDirectory(state) {
  const descriptorStats = await state.directoryHandle.stat({ bigint: true });
  const pathStatsValue = await lstat(state.directoryPath, { bigint: true });
  if (
    !descriptorStats.isDirectory()
    || !pathStatsValue.isDirectory()
    || !sameDirectory(state.directoryStats, descriptorStats)
    || !sameDirectory(state.directoryStats, pathStatsValue)
  ) failSnapshot("WORKER_FAILURE");
  const allowed = new Set([...COPY_NAMES, MARKER_NAME]);
  const entries = await readdir(state.directoryPath);
  if (entries.some((entry) => !allowed.has(entry))) {
    failSnapshot("WORKER_FAILURE");
  }
}

/**
 * @param {LeaseState} state
 * @param {string} name
 * @param {number} index
 */
async function unlinkDataPhase(state, name, index) {
  const bit = 1 << index;
  if ((state.audit.dataPhaseBits & bit) !== 0) return;
  state.audit.trace.push(`data-${index}-start`);
  const path = join(state.directoryPath, name);
  const pinned = state.entryStats.get(name);
  try {
    const current = await lstat(path, { bigint: true });
    if (pinned === undefined) {
      // A read-only SQLite connection to a WAL-profile snapshot may create its
      // own -wal/-shm sidecar even though that sidecar was absent at capture
      // time. Cleanup owns only these four fixed names inside its pinned
      // private directory. Admit a late sidecar as a new, owner-private,
      // single-link regular file on the same filesystem before unlinking it;
      // symlinks, hardlinks, replacements, foreign owners/modes, and oversized
      // files still fail closed.
      admitRegularFile(
        current,
        Number(state.directoryStats.uid),
        state.directoryStats.dev
      );
    } else if (!sameFile(pinned, current, false)) {
      failSnapshot("WORKER_FAILURE");
    }
    await unlink(path);
  } catch (cause) {
    if (safeErrorCode(cause) !== "ENOENT") throw cause;
  }
  state.audit.dataPhaseBits |= bit;
  state.audit.trace.push(`data-${index}-complete`);
}

/**
 * @param {LeaseState} state
 * @param {string} fault
 */
async function interruptIfNeeded(state, fault) {
  if (consumeFault(state.audit, /** @type {SnapshotQualificationFault} */ (fault))) {
    state.audit.cleanupInterruptions += 1;
    state.audit.trace.push(`interrupt:${fault}`);
    await Promise.resolve();
    state.audit.trace.push(`resume:${fault}`);
  }
}

/** @param {LeaseState} state */
async function closeDirectoryHandle(state) {
  if (state.directoryHandleClosed) return;
  state.directoryHandleClosed = true;
  try {
    await state.directoryHandle.close();
  } finally {
    state.audit.directoryFdClosed = 1;
  }
}

/**
 * @param {LeaseState} state
 * @param {boolean} acquisitionCleanup
 */
async function cleanupState(state, acquisitionCleanup) {
  state.audit.cleanupAttempts += 1;
  state.audit.trace.push("cleanup-start");
  try {
    await validateCleanupDirectory(state);
    state.audit.trace.push("cleanup-directory-valid");
    if (
      (acquisitionCleanup && consumeFault(state.audit, "cleanup-failure-after-primary"))
      || (!acquisitionCleanup && consumeFault(state.audit, "cleanup-first-failure"))
    ) {
      throw Object.assign(new Error("cleanup failed"), { code: "EIO" });
    }
    for (let index = 0; index < COPY_NAMES.length; index += 1) {
      const copyName = /** @type {string} */ (COPY_NAMES[index]);
      const interruptFault = /** @type {SnapshotQualificationFault} */ (
        DATA_INTERRUPT_FAULTS[index]
      );
      await unlinkDataPhase(state, copyName, index);
      await interruptIfNeeded(
        state,
        interruptFault
      );
    }
    if (state.audit.markerPhase === 0) {
      const markerPath = join(state.directoryPath, MARKER_NAME);
      try {
        const current = await lstat(markerPath, { bigint: true });
        if (
          state.markerStats === undefined
          || !sameFile(state.markerStats, current, false)
        ) failSnapshot("WORKER_FAILURE");
        await unlink(markerPath);
      } catch (cause) {
        if (safeErrorCode(cause) !== "ENOENT") throw cause;
      }
      state.audit.markerPhase = 1;
      state.audit.trace.push("marker-complete");
    }
    await interruptIfNeeded(state, "interrupt-after-marker-unlink");
    await interruptIfNeeded(state, "interrupt-before-directory-remove");
    if (state.audit.directoryPhase === 0) {
      const remaining = await readdir(state.directoryPath);
      if (remaining.length !== 0) failSnapshot("WORKER_FAILURE");
      await rmdir(state.directoryPath);
      state.audit.directoryPhase = 1;
      state.audit.trace.push("directory-complete");
    }
    await closeDirectoryHandle(state);
  } catch (cause) {
    state.audit.cleanupFailures += 1;
    if (!acquisitionCleanup && state.audit.primaryCode === undefined) {
      state.audit.primaryCode = "WORKER_FAILURE";
    }
    state.audit.trace.push("cleanup-failure");
    await closeDirectoryHandle(state);
    settleAudit(state.audit);
    return rethrowBrandedOrWorkerFailure(cause);
  }
  settleAudit(state.audit);
}

/** @this {object} */
function releaseLease() {
  const state = leaseStates.get(this);
  if (state === undefined) {
    return Promise.reject(snapshotFailure("WORKER_FAILURE"));
  }
  if (state.releasePromise === undefined) {
    state.releasePromise = cleanupState(state, false);
  }
  return state.releasePromise;
}

/** @this {object} */
function disposeLease() {
  return releaseLease.call(this);
}

/**
 * @param {SnapshotManifest} manifest
 * @param {LeaseState} state
 */
function createLease(manifest, state) {
  const lease = {
    snapshotDatabasePath: join(state.directoryPath, COPY_NAMES[0]),
    sourceManifest: manifest,
    release: releaseLease,
    [Symbol.asyncDispose]: disposeLease
  };
  leaseStates.set(lease, state);
  return objectFreeze(lease);
}

/**
 * @param {Readonly<{databasePath: string, sourceState: "closed-quiescent", fault?: SnapshotQualificationFault}>} options
 * @param {ReturnType<typeof createAuditContext>} audit
 */
async function acquireSnapshot(options, audit) {
  const startedAt = Date.now();
  /** @type {LeaseState | undefined} */
  let cleanup;
  /** @type {ConstructionCleanupState | undefined} */
  let constructionCleanup;
  try {
    const uid = expectedUid();
    admitPath(options.databasePath);
    const sourceParent = dirname(options.databasePath);
    let canonicalParent;
    try {
      canonicalParent = await realpath(sourceParent);
    } catch (cause) {
      if (safeErrorCode(cause) === "ENOENT") failSnapshot("SOURCE_NOT_FOUND");
      return rethrowBrandedOrWorkerFailure(cause);
    }
    if (canonicalParent !== sourceParent) failSnapshot("UNSUPPORTED_PROFILE");
    const parentStats = await lstat(sourceParent, { bigint: true });
    if (
      !parentStats.isDirectory()
      || parentStats.isSymbolicLink()
      || Number(parentStats.uid) !== uid
      || modeBits(parentStats) !== 0o700
    ) failSnapshot("UNSUPPORTED_PROFILE");
    await admitFilesystem(sourceParent, undefined);
    checkDeadline(audit, startedAt);

    /** @type {(import("node:fs").BigIntStats | undefined)[]} */
    const admitted = [];
    let totalSize = 0n;
    for (let index = 0; index < SOURCE_SUFFIXES.length; index += 1) {
      const stats = await pathStats(
        `${options.databasePath}${SOURCE_SUFFIXES[index]}`,
        index === 0 ? "initial-main" : "initial-sidecar"
      );
      if (stats !== undefined) {
        const comparisonUid = index === 0
          && consumeFault(audit, "wrong-owner-profile")
          ? uid + 1
          : uid;
        const comparisonDevice = index > 0
          && consumeFault(audit, "cross-device-sidecar-profile")
          ? /** @type {import("node:fs").BigIntStats} */ (admitted[0]).dev + 1n
          : index === 0
            ? undefined
            : /** @type {import("node:fs").BigIntStats} */ (admitted[0]).dev;
        admitRegularFile(stats, comparisonUid, comparisonDevice);
        totalSize += stats.size;
        if (totalSize > BigInt(MAX_TOTAL_BYTES)) {
          failSnapshot("UNSUPPORTED_PROFILE");
        }
      }
      admitted.push(stats);
    }
    audit.trace.push("source-admitted");

    const canonicalTemp = await realpath(tmpdir());
    const tempFilesystem = await admitFilesystem(canonicalTemp, audit.fault);
    if (audit.fault === "unsupported-temp-filesystem-profile") {
      audit.faultConsumed = true;
    }
    if (consumeFault(audit, "temp-directory-failure")) {
      throw Object.assign(new Error("temp directory failed"), { code: "EIO" });
    }
    const tempParentStats = await lstat(canonicalTemp, { bigint: true });
    const directoryPath = await mkdtemp(join(canonicalTemp, "attunegraph-admin-"));
    constructionCleanup = {
      directoryPath,
      audit,
      directoryHandleClosed: false
    };
    if (consumeFault(audit, "temp-child-chmod-failure")) {
      throw Object.assign(new Error("temp child chmod failed"), { code: "EIO" });
    }
    await chmod(directoryPath, 0o700);
    if (consumeFault(audit, "temp-child-open-failure")) {
      throw Object.assign(new Error("temp child open failed"), { code: "EIO" });
    }
    const directoryHandle = await open(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
    );
    constructionCleanup.directoryHandle = directoryHandle;
    if (consumeFault(audit, "temp-child-stat-failure")) {
      throw Object.assign(new Error("temp child stat failed"), { code: "EIO" });
    }
    const directoryStats = await directoryHandle.stat({ bigint: true });
    constructionCleanup.directoryStats = directoryStats;
    const directoryPathStats = await lstat(directoryPath, { bigint: true });
    if (
      !directoryStats.isDirectory()
      || directoryStats.isSymbolicLink()
      || Number(directoryStats.uid) !== uid
      || modeBits(directoryStats) !== 0o700
      || directoryStats.dev !== tempParentStats.dev
      || directoryStats.dev !== directoryPathStats.dev
      || directoryStats.ino !== directoryPathStats.ino
      || tempFilesystem.type === undefined
      || consumeFault(audit, "temp-child-profile-failure")
    ) {
      failSnapshot("UNSUPPORTED_PROFILE");
    }
    cleanup = {
      directoryPath,
      directoryHandle,
      directoryStats,
      entryStats: new Map(),
      audit,
      directoryHandleClosed: false
    };
    constructionCleanup = undefined;
    audit.trace.push("directory-admitted");

    /** @type {SnapshotManifestEntry[]} */
    const manifestEntries = [];
    for (let index = 0; index < SOURCE_SUFFIXES.length; index += 1) {
      const initialStats = admitted[index];
      if (initialStats === undefined) {
        manifestEntries.push(objectFreeze({ state: "absent" }));
        continue;
      }
      const copyName = /** @type {string} */ (COPY_NAMES[index]);
      const copied = await copyEntry(
        `${options.databasePath}${SOURCE_SUFFIXES[index]}`,
        join(directoryPath, copyName),
        initialStats,
        uid,
        directoryStats.dev,
        audit,
        startedAt
      );
      cleanup.entryStats.set(copyName, copied.destinationStats);
      if (audit.closeFailure) failSnapshot("WORKER_FAILURE");
      manifestEntries.push(copied.manifest);
    }
    audit.trace.push("copies-complete");

    for (let index = 0; index < SOURCE_SUFFIXES.length; index += 1) {
      checkDeadline(audit, startedAt);
      const finalStats = await pathStats(
        `${options.databasePath}${SOURCE_SUFFIXES[index]}`,
        "final"
      );
      const initialStats = admitted[index];
      if (consumeFault(audit, "source-change-before-final-check")) {
        failSnapshot("STORE_BUSY");
      }
      if (
        (initialStats === undefined) !== (finalStats === undefined)
        || (
          initialStats !== undefined
          && finalStats !== undefined
          && !sameFile(initialStats, finalStats)
        )
      ) failSnapshot("STORE_BUSY");
      if (initialStats !== undefined) {
        const digest = await hashSource(
          `${options.databasePath}${SOURCE_SUFFIXES[index]}`,
          audit,
          startedAt
        );
        if (audit.closeFailure) failSnapshot("WORKER_FAILURE");
        const entry = manifestEntries[index];
        if (entry?.state !== "present" || digest !== entry.sha256) {
          failSnapshot("STORE_BUSY");
        }
      }
    }
    audit.trace.push("source-final-check-complete");

    const marker = JSON.stringify({
      schemaVersion: 1,
      leaseId: randomBytes(32).toString("hex"),
      directory: {
        dev: directoryStats.dev.toString(10),
        ino: directoryStats.ino.toString(10),
        uid
      }
    });
    if (Buffer.byteLength(marker, "utf8") > 512) failSnapshot("WORKER_FAILURE");
    const markerPath = join(directoryPath, MARKER_NAME);
    let markerHandle;
    try {
      markerHandle = await open(
        markerPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_NOFOLLOW,
        0o600
      );
      audit.copyFdsOpened += 1;
      await markerHandle.chmod(0o600);
      await writeMarker(markerHandle, marker, audit, startedAt);
      const markerStats = await markerHandle.stat({ bigint: true });
      admitRegularFile(markerStats, uid, directoryStats.dev);
      cleanup.markerStats = markerStats;
    } finally {
      if (markerHandle !== undefined) await closeCopy(markerHandle, audit);
    }
    if (audit.closeFailure) failSnapshot("WORKER_FAILURE");
    audit.trace.push("marker-written");
    checkDeadline(audit, startedAt);

    const manifest = objectFreeze({
      main: manifestEntries[0],
      "-journal": manifestEntries[1],
      "-wal": manifestEntries[2],
      "-shm": manifestEntries[3]
    });
    return createLease(
      /** @type {SnapshotManifest} */ (manifest),
      cleanup
    );
  } catch (cause) {
    const code = readAttuneGraphAdminReadonlySnapshotFailure(cause) ?? "WORKER_FAILURE";
    audit.primaryCode = code;
    if (cleanup !== undefined) {
      try {
        await cleanupState(cleanup, true);
      } catch {
      }
    } else if (constructionCleanup !== undefined) {
      await cleanupConstructionState(constructionCleanup);
    } else {
      settleAudit(audit);
    }
    throw readAttuneGraphAdminReadonlySnapshotFailure(cause) === undefined
      ? snapshotFailure("WORKER_FAILURE")
      : cause;
  }
}

/** @param {unknown} options */
export async function acquireAttuneGraphAdminReadonlySnapshot(options) {
  const admitted = admitOptions(options, false);
  const audit = createAuditContext(undefined);
  return acquireSnapshot(admitted, audit);
}

/** @param {unknown} input */
export function startAttuneGraphAdminReadonlySnapshotQualification(input) {
  if (process.env.NODE_ENV !== "test") failSnapshot("UNSUPPORTED_PROFILE");
  const audit = createAuditContext(undefined);
  const acquisition = (async () => {
    let admitted;
    try {
      admitted = admitOptions(input, true);
      audit.fault = admitted.fault;
    } catch (cause) {
      const code = readAttuneGraphAdminReadonlySnapshotFailure(cause) ?? "WORKER_FAILURE";
      audit.primaryCode = code;
      settleAudit(audit);
      throw readAttuneGraphAdminReadonlySnapshotFailure(cause) === undefined
        ? snapshotFailure("WORKER_FAILURE")
        : cause;
    }
    return acquireSnapshot(admitted, audit);
  })();
  return objectFreeze({
    acquisition,
    terminalAudit: audit.terminalAudit
  });
}
