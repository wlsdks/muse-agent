/**
 * Passphrase-driven AES-256-GCM encryption used by
 * `muse export --encrypt` / `muse import --decrypt`.
 *
 * Layout (all values big-endian / network order where applicable):
 *
 *   bytes 0..3   magic   "MUSE" — 0x4D 0x55 0x53 0x45
 *   byte  4      version 0x01
 *   byte  5      reserved 0x00 (future-proofing flag byte)
 *   bytes 6..21  salt    16 random bytes (PBKDF2 salt)
 *   bytes 22..33 iv      12 random bytes (AES-GCM nonce)
 *   bytes 34..N  ciphertext (variable length)
 *   bytes N+1..N+16 auth-tag (16 bytes, GCM tag)
 *
 * KDF: PBKDF2-SHA256, 200_000 iterations, 32-byte key. The
 * salt + iv are random per encrypt; the auth-tag is appended
 * AFTER the ciphertext (Node's GCM API gives it separately, we
 * concatenate so the on-disk form is one blob).
 */

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const MUSE_EXPORT_MAGIC = Buffer.from([0x4d, 0x55, 0x53, 0x45]); // "MUSE"
const MUSE_EXPORT_VERSION = 0x01;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const PBKDF2_ITERS = 200_000;

/**
 * Encrypt `plain` with `passphrase`. Returns a single buffer
 * laid out per the header documented at the top of this file.
 * Caller is responsible for any filesystem write — keeping the
 * crypto pure means the unit tests don't have to mock fs.
 */
export function encryptExportBuffer(plain: Buffer, passphrase: string): Buffer {
  if (passphrase.length === 0) {
    throw new Error("passphrase cannot be empty");
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERS, KEY_BYTES, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    MUSE_EXPORT_MAGIC,
    Buffer.from([MUSE_EXPORT_VERSION, 0x00]),
    salt,
    iv,
    ciphertext,
    tag
  ]);
}

/**
 * Inspect a buffer's prefix to decide whether it's an encrypted
 * Muse export bundle. Cheap probe — used by `muse import` to
 * auto-detect without forcing the operator to pass `--decrypt`.
 */
export function isEncryptedExportBuffer(buffer: Buffer): boolean {
  if (buffer.length < MUSE_EXPORT_MAGIC.length + 2) return false;
  return buffer.subarray(0, MUSE_EXPORT_MAGIC.length).equals(MUSE_EXPORT_MAGIC);
}

/**
 * Decrypt a buffer produced by `encryptExportBuffer`. Throws a
 * clear, non-bytes-leaking error on wrong passphrase, magic
 * mismatch, unknown version, or auth-tag verification failure.
 * Callers surface the message to the user; the original
 * ciphertext is never echoed.
 */
export function decryptExportBuffer(blob: Buffer, passphrase: string): Buffer {
  if (!isEncryptedExportBuffer(blob)) {
    throw new Error("not an encrypted Muse export (missing MUSE magic header)");
  }
  const version = blob[MUSE_EXPORT_MAGIC.length];
  if (version !== MUSE_EXPORT_VERSION) {
    throw new Error(`unsupported encrypted Muse export version: ${(version ?? -1).toString()}`);
  }
  const headerLen = MUSE_EXPORT_MAGIC.length + 2; // magic + version + reserved
  const minLen = headerLen + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (blob.length < minLen) {
    throw new Error("encrypted Muse export is truncated (header + tag exceed input length)");
  }
  const salt = blob.subarray(headerLen, headerLen + SALT_BYTES);
  const iv = blob.subarray(headerLen + SALT_BYTES, headerLen + SALT_BYTES + IV_BYTES);
  const cipherStart = headerLen + SALT_BYTES + IV_BYTES;
  const tagStart = blob.length - TAG_BYTES;
  const ciphertext = blob.subarray(cipherStart, tagStart);
  const tag = blob.subarray(tagStart, blob.length);

  const key = pbkdf2Sync(passphrase, salt, PBKDF2_ITERS, KEY_BYTES, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM rejects on auth-tag mismatch (wrong passphrase / tamper).
    // Surface a clear message without echoing the bytes — the
    // tamper case is indistinguishable from the wrong-passphrase
    // case at this layer, so we name both.
    throw new Error("decryption failed: wrong passphrase or bundle was tampered with");
  }
}
