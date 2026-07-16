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

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import { decryptMemoryEnvelope, encryptMemoryEnvelope, isEncryptedMemoryEnvelope } from "@muse/memory";

import { atomicWriteFile, computeLockRetryDelay, withFileLock } from "./atomic-file-store.js";

export { computeLockRetryDelay, withFileLock };

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
