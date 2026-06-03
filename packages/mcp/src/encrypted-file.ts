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
const LOCK_RETRY_MS = 50;
const LOCK_MAX_ATTEMPTS = 60; // ~3s before giving up on a live holder

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true; // vanished between EEXIST and stat — stealable
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
  let acquired = false;
  for (let attempt = 0; !acquired; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(nonce, "utf8");
      acquired = true;
    } catch (cause) {
      if (!(cause instanceof Error) || (cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      if (await lockIsStale(lockPath)) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (attempt >= LOCK_MAX_ATTEMPTS) {
        throw new Error(`${file} is locked by another write in progress — retry shortly`, { cause });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  try {
    return await fn();
  } finally {
    if (await lockHoldsNonce(lockPath, nonce)) {
      await fs.unlink(lockPath).catch(() => undefined);
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
