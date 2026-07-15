import { readFileSync } from "node:fs";

import { decodeMaybeEncryptedCredentialsJson, isRecord } from "@muse/shared";

/**
 * Read a `~/.muse/{file}.json` credentials file into a
 * `{ providerId → record }` map. Used by every provider-builder
 * that wants the file fallback path when an env token is absent
 * (messaging, calendar, notes, tasks, models). Returns `{}` on a
 * missing file / malformed JSON so callers can layer "env or file"
 * lookups without try/catch noise.
 *
 * Format-preserving: transparently decrypts an AES-256-GCM envelope
 * (`MUSE_CREDENTIALS_ENCRYPT`-written) OR reads legacy plaintext —
 * an existing user's plaintext file keeps working unchanged. A wrong
 * `MUSE_MEMORY_KEY` on an ENCRYPTED file THROWS (fail-closed) rather
 * than silently returning `{}`, which would look like "no credentials
 * configured" and mask a real key mismatch.
 */
export function readCredentialsSync(
  file: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  // decodeMaybeEncryptedCredentialsJson THROWS on a wrong key — that error
  // must propagate here, never be folded into the "malformed JSON" catch.
  parsed = decodeMaybeEncryptedCredentialsJson(parsed, env);
  const shape = isRecord(parsed) ? parsed : {};
  const providers = isProviderRecord(shape.providers);
  if (!providers) {
    return {};
  }
  return providers;
}

function isProviderRecord(value: unknown): value is Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    return false;
  }
  for (const nested of Object.values(value)) {
    if (!isRecord(nested)) {
      return false;
    }
  }
  return true;
}

/**
 * Pull a non-empty string field from a credentials-record. Tolerant
 * by design — `undefined` record OR missing key OR wrong type OR
 * empty/whitespace-only string all return `undefined` so the caller
 * can chain with `??`. Trimmed so a whitespace-only value (a stray
 * `"   "` in `~/.muse/{models,mcp-credentials,...}.json`) is treated
 * as absent instead of silently becoming a broken credential — e.g. a
 * literal `Authorization: Bearer   ` header that fails auth upstream
 * with a confusing error, rather than falling back cleanly. Mirrors
 * every env-var token lookup in this file, which already `.trim()`s.
 */
export function stringField(record: { readonly [key: string]: unknown } | undefined, key: string): string | undefined {
  if (!record) {
    return undefined;
  }
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a positive integer from an env string, falling back when
 * absent / non-numeric / non-positive. Used by every "MUSE_*_LIMIT"
 * / "MUSE_*_CAPACITY" / "MUSE_*_TOPK" env knob.
 */
export function clampPositive(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
