/**
 * Encryption-at-rest for the local calendar store (`calendar.json` — event
 * titles / locations / notes are private). AES-256-GCM with a scrypt-derived
 * key, mirroring `packages/memory/src/memory-encryption.ts` IN-PACKAGE:
 * `@muse/calendar` must not depend on `@muse/memory` (it pulls @muse/db /
 * @muse/model), so the envelope shape is duplicated rather than imported.
 * The on-disk encrypted form is a JSON envelope distinct from the plaintext
 * `{ events }` shape, so a reader can detect the format WITHOUT a separate
 * flag and decrypt only when needed.
 *
 * SAFETY (the red-team contract): `decrypt*` THROWS on an auth-tag mismatch
 * (wrong key / tamper). The caller MUST fail closed — NEVER quarantine or
 * overwrite the ciphertext with empty data, because the encrypted bytes ARE
 * the user's calendar and re-deriving the key later must still recover them.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { isRecord, parseBooleanFromEnv } from "@muse/shared";

export interface EncryptedCalendarEnvelope {
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
 * variable memory uses — one key protects everything at rest, lock-step with
 * `memoryEncryptionSecret`), else a per-host fallback derived from username +
 * homedir + hostname, calendar-scoped so it never collides with the memory
 * store's own per-host fallback and stays independently recoverable.
 */
export function calendarEncryptionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MUSE_MEMORY_KEY?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return ["muse-calendar", userInfo().username, homedir(), hostname()].join(":");
}

export function isEncryptedCalendarEnvelope(value: unknown): value is EncryptedCalendarEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!isRecord(value)) return false;
  return value.version === 1 && value.algorithm === "aes-256-gcm"
    && typeof value.data === "string" && typeof value.iv === "string"
    && typeof value.salt === "string" && typeof value.tag === "string";
}

export function encryptCalendarEnvelope(plaintext: string, env: NodeJS.ProcessEnv = process.env): EncryptedCalendarEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(calendarEncryptionSecret(env), salt, 32);
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
export function decryptCalendarEnvelope(envelope: EncryptedCalendarEnvelope, env: NodeJS.ProcessEnv = process.env): string {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const key = scryptSync(calendarEncryptionSecret(env), salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("calendar store could not be decrypted: wrong MUSE_MEMORY_KEY (or the per-host key changed — e.g. a renamed machine), or the file was tampered with. The encrypted data is intact on disk; set the correct MUSE_MEMORY_KEY to recover it.");
  }
}

export function calendarEncryptionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanFromEnv(env.MUSE_CALENDAR_ENCRYPT, false);
}
