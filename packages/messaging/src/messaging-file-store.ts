import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_RETRY_ATTEMPTS = 240;
const STALE_LOCK_MS = 5 * 60_000;

const mutationQueues = new Map<string, Promise<unknown>>();

/**
 * Serialize one messaging file's read-modify-write across both this process
 * and independently started Muse daemons. The nonce check means a stale-lock
 * recovery never removes a replacement lock acquired by another process.
 */
export async function withMessagingFileMutation<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const prior = mutationQueues.get(file) ?? Promise.resolve();
  const next = prior.then(() => withMessagingFileLock(file, operation), () => withMessagingFileLock(file, operation));
  mutationQueues.set(file, next.then(() => undefined, () => undefined));
  return next;
}

/** Atomically write private messaging state with a collision-proof temporary file. */
export async function atomicWritePrivateFile(file: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.tmp-${process.pid.toString()}-${randomUUID()}`;
  await fs.writeFile(temporaryFile, contents, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryFile, file);
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/** Preserve malformed private state for recovery instead of silently overwriting it. */
export async function quarantineCorruptMessagingFile(file: string): Promise<void> {
  const quarantined = `${file}.corrupt-${Date.now().toString()}-${randomUUID()}`;
  await fs.rename(file, quarantined).catch(() => undefined);
}

async function withMessagingFileLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const lockFile = `${file}.lock`;
  const nonce = randomUUID();
  await acquireLock(lockFile, nonce);
  try {
    return await operation();
  } finally {
    await releaseLock(lockFile, nonce);
  }
}

async function acquireLock(lockFile: string, nonce: string): Promise<void> {
  await fs.mkdir(dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      try {
        await handle.writeFile(nonce, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (cause) {
      if (!isAlreadyExists(cause)) {
        throw cause;
      }
      if (await isStaleLock(lockFile)) {
        await fs.unlink(lockFile).catch(() => undefined);
        continue;
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error(`timed out waiting for messaging file lock: ${lockFile}`);
}

async function isStaleLock(lockFile: string): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(lockFile)).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
  }
}

async function releaseLock(lockFile: string, nonce: string): Promise<void> {
  try {
    if (await fs.readFile(lockFile, "utf8") === nonce) {
      await fs.unlink(lockFile);
    }
  } catch {
    // A replaced or externally removed lock is not ours to clean up.
  }
}

function isAlreadyExists(cause: unknown): boolean {
  return Boolean(cause) && typeof cause === "object" && (cause as { code?: string }).code === "EEXIST";
}
