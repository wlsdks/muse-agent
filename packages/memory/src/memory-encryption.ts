/**
 * Encryption-at-rest for the user-memory store (the "confided life": facts,
 * preferences, the typed user model). AES-256-GCM with a scrypt-derived key,
 * mirroring the proven `apps/cli/src/credential-store.ts` envelope so the two
 * at-rest paths agree. The on-disk encrypted form is a JSON envelope distinct
 * from the plaintext `{ version, users }`, so a reader can detect the format
 * WITHOUT a separate flag and decrypt only when needed.
 *
 * SAFETY (the red-team contract): `decrypt*` THROWS on an auth-tag mismatch
 * (wrong key / tamper). The caller MUST fail closed — NEVER quarantine or
 * overwrite the ciphertext with empty data, because the encrypted bytes ARE the
 * user's confided life and re-deriving the key later must still recover them.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";

export interface EncryptedMemoryEnvelope {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  /** base64 ciphertext / iv / salt / GCM auth-tag. */
  readonly data: string;
  readonly iv: string;
  readonly salt: string;
  readonly tag: string;
}

/**
 * The at-rest secret: an explicit `MUSE_MEMORY_KEY` (the daily-driver path — a
 * user-controlled passphrase that survives a hostname/username change), else a
 * per-host fallback derived from username + homedir + hostname (transparent, no
 * visible secret, but tied to the machine — a hostname change needs the explicit
 * key or the plaintext backup to recover). Mirrors `localCredentialSecret`.
 */
export function memoryEncryptionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MUSE_MEMORY_KEY?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return ["muse-memory", userInfo().username, homedir(), hostname()].join(":");
}

export function isEncryptedMemoryEnvelope(value: unknown): value is EncryptedMemoryEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as Partial<EncryptedMemoryEnvelope>;
  return e.version === 1 && e.algorithm === "aes-256-gcm"
    && typeof e.data === "string" && typeof e.iv === "string"
    && typeof e.salt === "string" && typeof e.tag === "string";
}

export function encryptMemoryEnvelope(plaintext: string, env: NodeJS.ProcessEnv = process.env): EncryptedMemoryEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(memoryEncryptionSecret(env), salt, 32);
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
 * Decrypt an envelope. THROWS a clear, non-bytes-leaking error on a wrong key or
 * tampering (GCM auth-tag mismatch) — the caller MUST surface it and leave the
 * ciphertext on disk untouched (fail-closed-without-destruction).
 */
export function decryptMemoryEnvelope(envelope: EncryptedMemoryEnvelope, env: NodeJS.ProcessEnv = process.env): string {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const key = scryptSync(memoryEncryptionSecret(env), salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("user-memory could not be decrypted: wrong MUSE_MEMORY_KEY (or the per-host key changed — e.g. a renamed machine), or the file was tampered with. The encrypted data is intact on disk; set the correct key or restore the .plaintext-backup file.");
  }
}
