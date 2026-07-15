/**
 * Encryption-at-rest for the high-value credential JSON stores — provider API
 * keys (`~/.muse/models.json`), channel bot tokens (`~/.muse/messaging.json`),
 * and MCP PATs (`~/.muse/mcp-credentials.json`). AES-256-GCM with a
 * scrypt-derived key, mirroring the PROVEN envelope
 * `packages/memory/src/memory-encryption.ts` / `packages/calendar/src/calendar-encryption.ts`
 * already use — same algorithm, same `MUSE_MEMORY_KEY`, same shape — so ONE
 * key protects the whole confided life. Lives in `@muse/shared` (a
 * dependency-free leaf package) rather than importing `@muse/memory` directly,
 * because `@muse/messaging` must not pull `@muse/memory`'s `@muse/db` /
 * `@muse/model` dependency chain just to encrypt a token file.
 *
 * SAFETY (the red-team contract, same as memory/calendar): `decrypt*` THROWS
 * on an auth-tag mismatch (wrong key / tamper). The caller MUST fail closed —
 * NEVER quarantine or overwrite the ciphertext with empty data, because the
 * encrypted bytes ARE the user's credentials and re-deriving the key later
 * must still recover them.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";

export interface EncryptedCredentialEnvelope {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  /** base64 ciphertext / iv / salt / GCM auth-tag. */
  readonly data: string;
  readonly iv: string;
  readonly salt: string;
  readonly tag: string;
}

/**
 * The at-rest secret: an explicit `MUSE_MEMORY_KEY` (deliberately the SAME
 * variable memory/calendar use — one key protects everything at rest), else a
 * per-host fallback derived from username + homedir + hostname, credentials-
 * scoped so it never collides with the memory/calendar stores' own per-host
 * fallbacks and stays independently recoverable.
 */
export function credentialEncryptionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MUSE_MEMORY_KEY?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return ["muse-credentials", userInfo().username, homedir(), hostname()].join(":");
}

export function isEncryptedCredentialEnvelope(value: unknown): value is EncryptedCredentialEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as Partial<EncryptedCredentialEnvelope>;
  return e.version === 1 && e.algorithm === "aes-256-gcm"
    && typeof e.data === "string" && typeof e.iv === "string"
    && typeof e.salt === "string" && typeof e.tag === "string";
}

export function encryptCredentialEnvelope(
  plaintext: string,
  env: NodeJS.ProcessEnv = process.env
): EncryptedCredentialEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(credentialEncryptionSecret(env), salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    algorithm: "aes-256-gcm",
    data: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    salt: salt.toString("base64"),
    tag: tag.toString("base64"),
    version: 1
  };
}

/**
 * Decrypt an envelope. THROWS a clear, non-bytes-leaking error on a wrong key
 * or tampering (GCM auth-tag mismatch) — the caller MUST surface it and leave
 * the ciphertext on disk untouched (fail-closed-without-destruction).
 */
export function decryptCredentialEnvelope(
  envelope: EncryptedCredentialEnvelope,
  env: NodeJS.ProcessEnv = process.env
): string {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const key = scryptSync(credentialEncryptionSecret(env), salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "credentials store could not be decrypted: wrong MUSE_MEMORY_KEY (or the per-host key changed — "
      + "e.g. a renamed machine), or the file was tampered with. The encrypted data is intact on disk; "
      + "set the correct MUSE_MEMORY_KEY to recover it."
    );
  }
}

/** Opt-in write gate — mirrors `MUSE_CALENDAR_ENCRYPT` for the credential stores. */
export function credentialEncryptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["true", "1", "yes", "on"].includes((env.MUSE_CREDENTIALS_ENCRYPT ?? "").trim().toLowerCase());
}

/**
 * Decode a parsed JSON value that MAY be an encrypted envelope: decrypt +
 * re-parse when it is one (THROWS fail-closed on a wrong key), else pass the
 * value through unchanged. Callers still get "no file" / "malformed JSON"
 * handling from their own try/catch around `JSON.parse` — this only handles
 * the encrypted-envelope hop, so a decrypt failure is never mistaken for
 * ordinary corruption and silently swallowed.
 */
export function decodeMaybeEncryptedCredentialsJson(parsed: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (!isEncryptedCredentialEnvelope(parsed)) {
    return parsed;
  }
  const decrypted = decryptCredentialEnvelope(parsed, env); // THROWS — propagate, do not catch
  return JSON.parse(decrypted);
}

/** Format-only check (no decrypt) — works without the key, for the "stay encrypted once encrypted" write rule. */
export async function isCredentialsFileEncryptedAtRest(file: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }
  try {
    return isEncryptedCredentialEnvelope(JSON.parse(raw));
  } catch {
    return false;
  }
}

/**
 * Snapshot the existing on-disk plaintext to `.plaintext-backup-<ts>` before
 * the FIRST plaintext→encrypted write, so a lost or rotated `MUSE_MEMORY_KEY`
 * can't make the credentials unrecoverable. Returns the backup path, or
 * `undefined` when there was no plaintext on disk to back up.
 */
export async function backupPlaintextCredentialsFile(file: string, existingPlaintext: string): Promise<string | undefined> {
  if (existingPlaintext.trim().length === 0) {
    return undefined;
  }
  const backupPath = `${file}.plaintext-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  await fs.writeFile(backupPath, existingPlaintext, { encoding: "utf8", mode: 0o600 });
  return backupPath;
}
