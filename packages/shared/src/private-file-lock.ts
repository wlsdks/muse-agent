import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { sleep } from "./sleep.js";

export interface PrivateFileLockOptions {
  readonly giveUpMs?: number;
  readonly retryDelayMs?: (attempt: number) => number;
}

export type PrivateFileLockErrorCode =
  | "PRIVATE_FILE_LOCK_CONTENDED"
  | "PRIVATE_FILE_LOCK_INVALID_OPTIONS"
  | "PRIVATE_FILE_LOCK_OWNERSHIP_LOST"
  | "PRIVATE_FILE_LOCK_UNSAFE";

const errorMessages: Readonly<Record<PrivateFileLockErrorCode, string>> = Object.freeze({
  PRIVATE_FILE_LOCK_CONTENDED: "Private file lock is held by another process.",
  PRIVATE_FILE_LOCK_INVALID_OPTIONS: "Private file lock options are invalid.",
  PRIVATE_FILE_LOCK_OWNERSHIP_LOST: "Private file lock ownership was lost.",
  PRIVATE_FILE_LOCK_UNSAFE: "Private file lock is unsafe."
});

export class PrivateFileLockError extends Error {
  readonly code: PrivateFileLockErrorCode;

  constructor(code: PrivateFileLockErrorCode) {
    super(errorMessages[code]);
    this.name = "PrivateFileLockError";
    this.code = code;
    this.stack = `${this.name}: ${this.message}`;
  }
}

const DEFAULT_GIVE_UP_MS = 30_000;
const ownerUid = (): number | undefined => process.getuid?.();

type LockStat = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  isDirectory: () => boolean;
  isFile: () => boolean;
  mode: number | bigint;
  size: number | bigint;
  uid: number | bigint;
}>;
type FileIdentity = Readonly<{ dev: number | bigint; ino: number | bigint }>;

function identityOf(stat: LockStat): FileIdentity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isOwnedByCurrentUser(stat: LockStat): boolean {
  return ownerUid() === undefined || Number(stat.uid) === ownerUid();
}

function isPrivateRegularFile(stat: LockStat): boolean {
  return stat.isFile() && (Number(stat.mode) & 0o777) === 0o600 && isOwnedByCurrentUser(stat);
}

function isOwnedRegularFile(stat: LockStat): boolean {
  return stat.isFile() && isOwnedByCurrentUser(stat);
}

function isPrivateDirectory(stat: LockStat): boolean {
  return stat.isDirectory() && (Number(stat.mode) & 0o022) === 0 && isOwnedByCurrentUser(stat);
}

function resolveGiveUpMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GIVE_UP_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new PrivateFileLockError("PRIVATE_FILE_LOCK_INVALID_OPTIONS");
  }
  return value;
}

const defaultRetryDelayMs = (attempt: number): number => Math.min(250, 25 * 2 ** attempt);
const noFollowFlag = (): number => process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const directoryFlags = (): number => constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_DIRECTORY | constants.O_NOFOLLOW);

type ValidatedParent = Readonly<{
  handle: Awaited<ReturnType<typeof fs.open>>;
  identity: FileIdentity;
  path: string;
}>;

async function openValidatedParent(file: string): Promise<ValidatedParent> {
  const parentPath = dirname(file);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const beforeOpen = await fs.lstat(parentPath);
    if (!isPrivateDirectory(beforeOpen)) throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
    handle = await fs.open(parentPath, directoryFlags());
    const opened = await handle.stat();
    const afterOpen = await fs.lstat(parentPath);
    if (
      !isPrivateDirectory(opened) ||
      !isPrivateDirectory(afterOpen) ||
      !sameIdentity(beforeOpen, opened) ||
      !sameIdentity(beforeOpen, afterOpen)
    ) {
      throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
    }
    return Object.freeze({ handle, identity: identityOf(opened), path: parentPath });
  } catch (cause) {
    await handle?.close().catch(() => undefined);
    if (cause instanceof PrivateFileLockError) throw cause;
    throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
  }
}

async function assertParentIdentity(parent: ValidatedParent, code: PrivateFileLockErrorCode): Promise<void> {
  try {
    const [pathStat, handleStat] = await Promise.all([fs.lstat(parent.path), parent.handle.stat()]);
    if (
      !isPrivateDirectory(pathStat) ||
      !isPrivateDirectory(handleStat) ||
      !sameIdentity(parent.identity, pathStat) ||
      !sameIdentity(parent.identity, handleStat)
    ) {
      throw new PrivateFileLockError(code);
    }
  } catch (cause) {
    if (cause instanceof PrivateFileLockError) throw cause;
    throw new PrivateFileLockError(code);
  }
}

type ExistingLockProbe = "safe" | "vanished";

/** Inspect only directory metadata. A pre-existing lock is never opened or read. */
async function probeExistingLock(file: string): Promise<ExistingLockProbe> {
  try {
    const stat = await fs.lstat(file);
    if (!isPrivateRegularFile(stat)) throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
    return "safe";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "vanished";
    if (cause instanceof PrivateFileLockError) throw cause;
    throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
  }
}

async function restoreMovedEntry(file: string, quarantinePath: string): Promise<void> {
  try {
    await fs.link(quarantinePath, file);
    const [restored, quarantined] = await Promise.all([fs.lstat(file), fs.lstat(quarantinePath)]);
    if (sameIdentity(restored, quarantined)) {
      await fs.unlink(quarantinePath).catch(() => undefined);
    }
  } catch {
    // Preserve the moved entry at the quarantine path when exact restoration is unsafe.
  }
}

async function quarantineAndRemoveOwnedEntry(
  file: string,
  acquiredIdentity: FileIdentity,
  parent: ValidatedParent,
  code: PrivateFileLockErrorCode,
  expectedNonce?: Buffer
): Promise<void> {
  const quarantinePath = `${file}.release-${randomUUID()}`;
  let quarantineHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let moved = false;
  try {
    await assertParentIdentity(parent, code);
    const beforeRename = await fs.lstat(file);
    if (!isOwnedRegularFile(beforeRename) || !sameIdentity(acquiredIdentity, beforeRename)) {
      throw new PrivateFileLockError(code);
    }
    try {
      await fs.lstat(quarantinePath);
      throw new PrivateFileLockError(code);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await fs.rename(file, quarantinePath);
    moved = true;
    await assertParentIdentity(parent, code);

    quarantineHandle = await fs.open(
      quarantinePath,
      constants.O_RDONLY | constants.O_NONBLOCK | noFollowFlag()
    );
    const [quarantined, opened] = await Promise.all([fs.lstat(quarantinePath), quarantineHandle.stat()]);
    if (
      !isOwnedRegularFile(quarantined) ||
      !isOwnedRegularFile(opened) ||
      !sameIdentity(acquiredIdentity, quarantined) ||
      !sameIdentity(acquiredIdentity, opened)
    ) {
      throw new PrivateFileLockError(code);
    }
    if (expectedNonce !== undefined) {
      if (Number(opened.size) !== expectedNonce.byteLength) throw new PrivateFileLockError(code);
      const readback = Buffer.alloc(expectedNonce.byteLength);
      const { bytesRead } = await quarantineHandle.read(readback, 0, readback.byteLength, 0);
      if (bytesRead !== expectedNonce.byteLength || !timingSafeEqual(readback, expectedNonce)) {
        throw new PrivateFileLockError(code);
      }
    }
    await assertParentIdentity(parent, code);
    const beforeDelete = await fs.lstat(quarantinePath);
    if (!sameIdentity(acquiredIdentity, beforeDelete)) {
      throw new PrivateFileLockError(code);
    }
    await fs.unlink(quarantinePath);
    moved = false;
  } catch (cause) {
    if (moved) {
      await assertParentIdentity(parent, code)
        .then(() => restoreMovedEntry(file, quarantinePath))
        .catch(() => undefined);
    }
    if (cause instanceof PrivateFileLockError) throw cause;
    throw new PrivateFileLockError(code);
  } finally {
    await quarantineHandle?.close().catch(() => undefined);
  }
}

async function releasePrivateLock(
  file: string,
  nonce: Buffer,
  acquiredIdentity: FileIdentity,
  parent: ValidatedParent
): Promise<void> {
  await quarantineAndRemoveOwnedEntry(
    file,
    acquiredIdentity,
    parent,
    "PRIVATE_FILE_LOCK_OWNERSHIP_LOST",
    nonce
  );
}

/** Run an operation while owning the exact private lock path supplied by the caller. */
export async function withPrivateFileLock<T>(
  file: string,
  operation: () => Promise<T>,
  options: PrivateFileLockOptions = {}
): Promise<T> {
  const giveUpMs = resolveGiveUpMs(options.giveUpMs);
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  if (typeof retryDelayMs !== "function") {
    throw new PrivateFileLockError("PRIVATE_FILE_LOCK_INVALID_OPTIONS");
  }
  const parent = await openValidatedParent(file);
  const nonce = Buffer.from(randomUUID(), "utf8");
  const startedAt = performance.now();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let createdIdentity: FileIdentity | undefined;
  let acquiredIdentity: FileIdentity | undefined;

  try {
    for (let attempt = 0; handle === undefined; attempt += 1) {
      await assertParentIdentity(parent, "PRIVATE_FILE_LOCK_UNSAFE");
      try {
        handle = await fs.open(
          file,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollowFlag(),
          0o600
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
        }
        if ((await probeExistingLock(file)) === "vanished") continue;
        const elapsedMs = performance.now() - startedAt;
        if (elapsedMs >= giveUpMs) {
          throw new PrivateFileLockError("PRIVATE_FILE_LOCK_CONTENDED");
        }
        let requestedDelayMs: number;
        try {
          requestedDelayMs = retryDelayMs(attempt);
        } catch {
          throw new PrivateFileLockError("PRIVATE_FILE_LOCK_INVALID_OPTIONS");
        }
        if (!Number.isFinite(requestedDelayMs) || requestedDelayMs < 0) {
          throw new PrivateFileLockError("PRIVATE_FILE_LOCK_INVALID_OPTIONS");
        }
        await sleep(Math.min(requestedDelayMs, giveUpMs - elapsedMs));
      }
    }

    let setupFailure: PrivateFileLockError | undefined;
    let nonceWritten = false;
    try {
      const createdStat = await handle.stat();
      if (!isOwnedRegularFile(createdStat)) throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
      createdIdentity = identityOf(createdStat);
      await handle.chmod(0o600);
      await handle.writeFile(nonce);
      nonceWritten = true;
      await handle.sync();
      const [pathStat, handleStat] = await Promise.all([fs.lstat(file), handle.stat()]);
      const readback = Buffer.alloc(nonce.byteLength);
      const { bytesRead } = await handle.read(readback, 0, readback.byteLength, 0);
      await assertParentIdentity(parent, "PRIVATE_FILE_LOCK_UNSAFE");
      if (
        !isPrivateRegularFile(pathStat) ||
        !isPrivateRegularFile(handleStat) ||
        !sameIdentity(pathStat, handleStat) ||
        Number(handleStat.size) !== nonce.byteLength ||
        bytesRead !== nonce.byteLength ||
        !timingSafeEqual(readback, nonce)
      ) {
        throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
      }
      acquiredIdentity = identityOf(handleStat);
    } catch (cause) {
      setupFailure = cause instanceof PrivateFileLockError
        ? cause
        : new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
    } finally {
      await handle.close().catch(() => undefined);
    }

    if (setupFailure !== undefined) {
      if (createdIdentity !== undefined) {
        await quarantineAndRemoveOwnedEntry(
          file,
          createdIdentity,
          parent,
          "PRIVATE_FILE_LOCK_UNSAFE",
          nonceWritten ? nonce : undefined
        ).catch(() => undefined);
      }
      throw setupFailure;
    }

    if (acquiredIdentity === undefined) throw new PrivateFileLockError("PRIVATE_FILE_LOCK_UNSAFE");
    const outcome = await operation().then(
      (value) => ({ ok: true, value }) as const,
      (cause: unknown) => ({ cause, ok: false }) as const
    );
    await releasePrivateLock(file, nonce, acquiredIdentity, parent);
    if (!outcome.ok) throw outcome.cause;
    return outcome.value;
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}
