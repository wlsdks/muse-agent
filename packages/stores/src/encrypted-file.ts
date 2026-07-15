/**
 * Reusable encryption-at-rest for the function-based JSON stores (episodes,
 * action-log, …), reusing the SAME AES-256-GCM envelope + key as the user-memory
 * store (`@muse/memory`), so ONE `MUSE_MEMORY_KEY` (or the per-host fallback)
 * protects the whole confided life. Carries the red-teamed safety contract from
 * the user-memory slice:
 *
 *  - read NEVER writes; decrypt-or-read-plaintext + return the format.
 *  - a WRONG key FAILS CLOSED — `decryptMemoryEnvelope` THROWS, so the caller
 *    surfaces it and leaves the ciphertext byte-unchanged (never quarantines or
 *    empties it). A write under a wrong key throws too (read-before-write).
 *  - the one-shot migration writes a plaintext backup BEFORE encrypting and runs
 *    under a CROSS-PROCESS O_EXCL lock (with stale-lock stealing) so a concurrent
 *    ordinary write in another process cannot race it and lose data.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { decryptMemoryEnvelope, encryptMemoryEnvelope, isEncryptedMemoryEnvelope } from "@muse/memory";
import { hasNodeErrorCodeIn, isNodeErrorCode, sleep, withBestEffort, NODE_ERROR_CODES } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";

/** Read the file as PLAINTEXT text + whether it was encrypted on disk. read NEVER writes. */
export async function readMaybeEncrypted(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly text: string | undefined; readonly encrypted: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { encrypted: false, text: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { encrypted: false, text: raw }; // non-JSON plaintext — the store's own corrupt-quarantine handles it
  }
  if (isEncryptedMemoryEnvelope(parsed)) {
    return { encrypted: true, text: decryptMemoryEnvelope(parsed, env) }; // THROWS fail-closed on a wrong key
  }
  return { encrypted: false, text: raw };
}

/**
 * Atomic write; encrypts `text` when `encrypted`, else writes it as-is
 * (format-preserving). Delegates to `atomicWriteFile` — the hardened primitive
 * (randomUUID tmp suffix so same-millisecond writers don't collide on rename;
 * fsync before rename so a crash can't commit a torn file, which for an
 * encrypted store would be an undecryptable lock-out, not just an empty store).
 */
export async function writeMaybeEncrypted(
  file: string,
  text: string,
  encrypted: boolean,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const payload = encrypted ? `${JSON.stringify(encryptMemoryEnvelope(text, env), null, 2)}\n` : text;
  await atomicWriteFile(file, payload);
}

/** Format-only check (no decrypt) — the `encryption-status` signal, works without the key. */
export async function isFileEncryptedAtRest(file: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }
  try {
    return isEncryptedMemoryEnvelope(JSON.parse(raw));
  } catch {
    return false;
  }
}

const LOCK_STALE_MS = 30_000;
// A live holder is given the SAME 30s as the stale-steal threshold — a holder
// that has genuinely lived that long is about to be treated as stale by
// probeLock anyway, so giving up any earlier would starve a waiter for no
// reason and giving up later would just duplicate the steal path.
const LOCK_GIVE_UP_MS = LOCK_STALE_MS;
const LOCK_RETRY_BASE_MS = 25;
const LOCK_RETRY_CAP_MS = 250;

/**
 * Decorrelated-jitter exponential backoff for a contended lock retry: base 25ms,
 * doubling per attempt, capped at 250ms, then widened by a [0.5, 1.5) jitter
 * factor so N parallel writers who all hit EEXIST in the same tick don't retry
 * in lockstep (the fixed 50ms interval this replaces caused exactly that herd).
 */
export function computeLockRetryDelay(attempt: number): number {
  const exponential = Math.min(LOCK_RETRY_CAP_MS, LOCK_RETRY_BASE_MS * 2 ** attempt);
  const jitter = 0.5 + Math.random();
  return exponential * jitter;
}

type LockProbe = "live" | "stale" | "vanished";

async function probeLock(lockPath: string): Promise<LockProbe> {
  try {
    return Date.now() - (await fs.stat(lockPath)).mtimeMs > LOCK_STALE_MS ? "stale" : "live";
  } catch (cause) {
    // ONLY ENOENT means "vanished between EEXIST and stat". Any other stat
    // error (win32 EPERM during a delete-pending window, an AV scan touching
    // the file) says nothing about the holder — calling it stale deletes a
    // LIVE holder's lock and admits a second writer (a real lost-update
    // observed on the windows-latest runner).
    return isNodeErrorCode(cause, NODE_ERROR_CODES.ENOENT) ? "vanished" : "live";
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
 * Run `fn` holding a single CROSS-PROCESS O_EXCL lock for `file` so a migration
 * and an ordinary read-modify-write in different processes can't race (the
 * per-process `withFileMutationQueue` doesn't span processes). A lock older than
 * LOCK_STALE_MS (a crashed holder) is STOLEN so a crash can't block writes
 * forever; reads stay lock-free (the atomic rename keeps a reader consistent).
 *
 * Each holder stamps a unique nonce into the lock file and removes it on exit
 * ONLY if it still holds that nonce — so a >30s-slow holder whose lock was
 * stolen mid-flight cannot delete the new holder's lock (which would orphan the
 * stealer's critical section and admit a third concurrent writer). A stolen
 * slow holder thus degrades to the pre-lock last-writer-wins, never worse.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const nonce = `${process.pid.toString()}-${randomUUID()}`;
  const startedAt = Date.now();
  let acquired = false;
  for (let attempt = 0; !acquired; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(nonce, "utf8");
      acquired = true;
    } catch (cause) {
      // win32 surfaces a concurrent unlink-vs-open race on the lock file as
      // EPERM/EACCES/EBUSY rather than EEXIST — same meaning: contended, retry.
      const contended = hasNodeErrorCodeIn(
        cause,
        NODE_ERROR_CODES.EEXIST,
        NODE_ERROR_CODES.EPERM,
        NODE_ERROR_CODES.EACCES,
        NODE_ERROR_CODES.EBUSY
      );
  if (!(cause instanceof Error) || !contended) {
    throw cause;
  }
      const probe = await probeLock(lockPath);
      if (probe === "vanished") {
        // Nothing to steal — the holder already released. Unlinking here would
        // race a NEW holder that grabbed the lock between our stat and unlink
        // (deleting a live lock admits a second writer); just retry the open.
        continue;
      }
      if (probe === "stale") {
        await withBestEffort(fs.unlink(lockPath), undefined);
        continue;
      }
  if (Date.now() - startedAt >= LOCK_GIVE_UP_MS) {
        throw new Error(`${file} is locked by another write in progress — retry shortly`, { cause });
      }
      await sleep(computeLockRetryDelay(attempt));
    } finally {
      await withBestEffort(handle?.close() ?? Promise.resolve(), undefined);
    }
  }
  try {
    return await fn();
  } finally {
    if (await lockHoldsNonce(lockPath, nonce)) {
      await withBestEffort(fs.unlink(lockPath), undefined);
    }
  }
}

export interface EncryptAtRestOptions {
  /**
   * Plaintext to SEED when the store file does not exist yet, so encrypting an
   * empty store still ESTABLISHES the encrypted format on disk — otherwise the
   * first later write (which peeks the on-disk format) would silently land in
   * plaintext and the user's "encrypt" intent would be lost. Pass the store's
   * canonical empty body, e.g. `'{"episodes":[]}\n'`.
   */
  readonly emptyContent?: string;
  readonly nowIso?: string;
}

/**
 * One-shot migrate a plaintext JSON store to encryption-at-rest: snapshot the
 * plaintext to `.plaintext-backup-<ts>` (recovery if the key derivation later
 * changes), then rewrite encrypted. Cross-process locked. Idempotent.
 */
export async function encryptFileAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  options: EncryptAtRestOptions = {}
): Promise<{ readonly alreadyEncrypted: boolean; readonly backupPath?: string }> {
  const nowIso = options.nowIso ?? new Date().toISOString();
  return withFileLock(file, async () => {
    const { text, encrypted } = await readMaybeEncrypted(file, env);
    if (encrypted) {
      return { alreadyEncrypted: true };
    }
    const plaintext = text ?? options.emptyContent;
    if (plaintext === undefined) {
      return { alreadyEncrypted: false }; // no file and no seed — nothing on disk to lose; a future write establishes the format
    }
    await fs.mkdir(dirname(file), { recursive: true });
    let backupPath: string | undefined;
    if (text !== undefined) {
      backupPath = `${file}.plaintext-backup-${nowIso.replace(/[:.]/gu, "-")}`;
      await fs.writeFile(backupPath, text, { encoding: "utf8", mode: 0o600 });
    }
    await writeMaybeEncrypted(file, plaintext, true, env);
    return { alreadyEncrypted: false, backupPath };
  });
}

/** Reverse the migration — rewrite plaintext. Reads (decrypts) first → throws fail-closed on a wrong key. */
export async function decryptFileAtRest(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly alreadyPlaintext: boolean }> {
  return withFileLock(file, async () => {
    const { text, encrypted } = await readMaybeEncrypted(file, env);
    if (!encrypted || text === undefined) {
  return { alreadyPlaintext: true };
}

    await writeMaybeEncrypted(file, text, false, env);
    return { alreadyPlaintext: false };
  });
}
