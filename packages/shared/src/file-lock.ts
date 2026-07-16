import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { isErrorLike } from "./error-utils.js";
import { sleep } from "./sleep.js";

const mutationQueues = new Map<string, Promise<unknown>>();
const resolvedPromise = async (): Promise<unknown> => undefined;

/** Serialize a read-modify-write operation within this process, keyed by file. */
export async function withFileMutationQueue<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const prior = mutationQueues.get(file) ?? resolvedPromise();
  const next = prior.then(operation, operation);
  mutationQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

const LOCK_STALE_MS = 30_000;
const LOCK_GIVE_UP_MS = LOCK_STALE_MS;
const LOCK_RETRY_BASE_MS = 25;
const LOCK_RETRY_CAP_MS = 250;

export interface FileLockOptions {
  /** Age at which a lock from a crashed process may be safely stolen. */
  readonly staleMs?: number;
  /** Maximum time to wait for a live lock before failing closed. */
  readonly giveUpMs?: number;
}

/** Decorrelated-jitter exponential backoff for a contended cross-process lock. */
export function computeLockRetryDelay(attempt: number): number {
  const exponential = Math.min(LOCK_RETRY_CAP_MS, LOCK_RETRY_BASE_MS * 2 ** attempt);
  return exponential * (0.5 + Math.random());
}

type LockProbe = "live" | "stale" | "vanished";

function resolveLockDuration(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

async function probeLock(lockPath: string, staleMs: number): Promise<LockProbe> {
  try {
    return Date.now() - (await fs.stat(lockPath)).mtimeMs > staleMs ? "stale" : "live";
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "vanished" : "live";
  }
}

async function lockHoldsNonce(lockPath: string, nonce: string): Promise<boolean> {
  try {
    return (await fs.readFile(lockPath, "utf8")) === nonce;
  } catch {
    return false;
  }
}

/**
 * Run an operation under an O_EXCL cross-process file lock. A stale lock is
 * safely stolen, and nonce ownership prevents a former holder from deleting a
 * newer holder's lock. Readers remain lock-free when writers use atomic rename.
 */
export async function withFileLock<T>(file: string, operation: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  await fs.mkdir(dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const nonce = `${process.pid.toString()}-${randomUUID()}`;
  const startedAt = Date.now();
  const staleMs = resolveLockDuration(options.staleMs, LOCK_STALE_MS, "staleMs");
  const giveUpMs = resolveLockDuration(options.giveUpMs, LOCK_GIVE_UP_MS, "giveUpMs");
  let acquired = false;
  for (let attempt = 0; !acquired; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(nonce, "utf8");
      acquired = true;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const contended = code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!isErrorLike(cause) || !contended) {
        throw cause;
      }
      const probe = await probeLock(lockPath, staleMs);
      if (probe === "vanished") continue;
      if (probe === "stale") {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= giveUpMs) {
        throw new Error(`${file} is locked by another write in progress — retry shortly`, { cause });
      }
      await sleep(computeLockRetryDelay(attempt));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  try {
    return await operation();
  } finally {
    if (await lockHoldsNonce(lockPath, nonce)) {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}
