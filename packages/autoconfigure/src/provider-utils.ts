import { readFileSync } from "node:fs";

/**
 * Read a `~/.muse/{file}.json` credentials file into a
 * `{ providerId → record }` map. Used by every provider-builder
 * that wants the file fallback path when an env token is absent
 * (messaging, calendar, notes, tasks, models). Returns `{}` on any
 * read / parse failure so callers can layer "env or file" lookups
 * without try/catch noise.
 */
export function readCredentialsSync(file: string): Record<string, Record<string, unknown>> {
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { readonly providers?: unknown };
    if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
      return {};
    }
    return { ...(parsed.providers as Record<string, Record<string, unknown>>) };
  } catch {
    return {};
  }
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
