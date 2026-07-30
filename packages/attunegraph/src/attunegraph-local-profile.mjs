import { Buffer } from "node:buffer";
import { chmodSync, lstatSync, realpathSync, statfsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import process from "node:process";

import { fail } from "./attunegraph-local-protocol.mjs";

const OWNER_ONLY_MASK = 0o077;
const FILESYSTEMS = new Map([
  ["darwin", new Set([0x11n, 0x1an])],
  ["linux", new Set([0xef53n, 0x58465342n, 0x9123683en, 0x794c7630n, 0x01021994n])]
]);

export function assertNodeProfile() {
  const [major = Number.NaN, minor = Number.NaN, patch = Number.NaN] =
    process.versions.node.split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)
    || major < 24 || (major === 24 && minor < 12)) {
    fail("UNSUPPORTED_STORE_PROFILE", "local AttuneGraph requires Node >=24.12.0");
  }
}

/** @param {string} version */
export function supportedSqliteVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (major === 3 && minor === 44 && patch >= 6)
    || (major === 3 && minor === 50 && patch >= 7)
    || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)));
}

/** @param {unknown} cause @returns {cause is NodeJS.ErrnoException} */
function isErrno(cause) {
  return cause instanceof Error
    && typeof /** @type {NodeJS.ErrnoException} */ (cause).code === "string";
}

/** @param {string} path @param {boolean} allowAbsent */
function assertOwnedRegularFile(path, allowAbsent) {
  let info;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (cause) {
    if (allowAbsent && isErrno(cause) && cause.code === "ENOENT") return undefined;
    fail("UNSUPPORTED_STORE_PROFILE", "database file profile could not be inspected", cause);
  }
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== BigInt(process.geteuid?.() ?? -1)
    || (Number(info.mode) & OWNER_ONLY_MASK) !== 0) {
    fail("UNSUPPORTED_STORE_PROFILE", "database files must be regular, owner-only files");
  }
  return info;
}

/** @typedef {{ readonly databasePath: string, readonly existed: boolean, readonly wasEmpty: boolean }} DatabasePathProfile */

/** @param {unknown} value @returns {DatabasePathProfile} */
export function validateDatabasePath(value) {
  if (typeof value !== "string" || value.includes("\0") || value.startsWith("file:")
    || value === ":memory:" || !isAbsolute(value) || normalize(value) !== value
    || Buffer.byteLength(value, "utf8") > 4_096) {
    fail("UNSUPPORTED_STORE_PROFILE", "databasePath must be a normalized absolute file path");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    fail("UNSUPPORTED_STORE_PROFILE", "the current operating system has no reviewed local profile");
  }
  const parent = dirname(value);
  let canonicalParent;
  try {
    canonicalParent = realpathSync(parent);
  } catch (cause) {
    fail("UNSUPPORTED_STORE_PROFILE", "database parent directory must already exist", cause);
  }
  if (canonicalParent !== parent) {
    fail("UNSUPPORTED_STORE_PROFILE", "database path must not contain symlinked or noncanonical parent components");
  }
  const canonicalDatabasePath = join(canonicalParent, basename(value));
  let parentInfo;
  try {
    parentInfo = lstatSync(canonicalParent, { bigint: true });
  } catch (cause) {
    fail("UNSUPPORTED_STORE_PROFILE", "database parent directory must already exist", cause);
  }
  if (!parentInfo.isDirectory()) {
    fail("UNSUPPORTED_STORE_PROFILE", "database parent must be a real directory");
  }
  const allowed = FILESYSTEMS.get(process.platform);
  let fileSystem;
  try {
    fileSystem = statfsSync(canonicalParent, { bigint: true });
  } catch (cause) {
    fail("UNSUPPORTED_STORE_PROFILE", "database filesystem could not be classified", cause);
  }
  if (!allowed?.has(fileSystem.type)) {
    fail("UNSUPPORTED_STORE_PROFILE", "database filesystem is not in the reviewed local allowlist");
  }
  const existing = assertOwnedRegularFile(canonicalDatabasePath, true);
  assertOwnedRegularFile(`${canonicalDatabasePath}-wal`, true);
  assertOwnedRegularFile(`${canonicalDatabasePath}-shm`, true);
  return Object.freeze({
    databasePath: canonicalDatabasePath,
    existed: existing !== undefined,
    wasEmpty: existing === undefined || existing.size === 0n
  });
}

/** @param {string} databasePath */
export function assertSidecars(databasePath) {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch (cause) {
      if (!isErrno(cause) || cause.code !== "ENOENT") {
        fail("UNSUPPORTED_STORE_PROFILE", "database file permissions could not be secured", cause);
      }
    }
  }
  assertOwnedRegularFile(databasePath, false);
  assertOwnedRegularFile(`${databasePath}-wal`, true);
  assertOwnedRegularFile(`${databasePath}-shm`, true);
}
