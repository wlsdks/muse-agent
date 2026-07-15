import type { RuntimeSettingType } from "@muse/runtime-settings";
import type { JsonObject } from "@muse/shared";
import { isRecord } from "@muse/shared";
export { isRecord };

/**
 * Generic shape-inspection / simple-value helpers extracted from
 * `server-helpers.ts`. Each function is a one-liner that answers
 * "is this value a known shape?" or "extract the typed view of this
 * value if applicable, else undefined".
 *
 * Lifted out so `server-helpers.ts` can stay focused on agent-run
 * shaping and parse pipelines. Re-exported from `server-helpers.ts`
 * so the existing import sites (admin-session-compat-routes,
 * compat-session-store, compat-auth, server-helpers itself, etc.)
 * keep working without import-site edits.
 */

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

export function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function optionalNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}

export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function readString(value: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "string" ? value[key] : undefined;
}

export function readNullableString(
  value: Record<string, unknown>,
  key: string,
  fallback?: string
): string | null | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return value[key] === null || typeof value[key] === "string" ? value[key] : undefined;
}

export function readBoolean(value: Record<string, unknown>, key: string, fallback?: boolean): boolean | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "boolean" ? value[key] : undefined;
}

export function readNumber(value: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : undefined;
}

export function readStringArray(
  value: Record<string, unknown>,
  key: string,
  fallback?: readonly string[]
): readonly string[] | false | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")
    ? value[key]
    : false;
}

export function readJsonObject(
  value: Record<string, unknown>,
  key: string,
  fallback?: JsonObject
): JsonObject | false | undefined {
  if (!hasOwn(value, key)) {
    return fallback;
  }

  return isJsonObject(value[key]) ? value[key] : false;
}

export function parseRuntimeSettingType(value: unknown): RuntimeSettingType | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return normalized === "string" || normalized === "number" || normalized === "boolean" || normalized === "json"
    ? normalized
    : undefined;
}

const STRICT_INT_RE = /^\d+$/u;

/**
 * Strict `?limit=` parse for history endpoints. Returns `undefined`
 * (→ the store falls back to its own default) when the param is
 * absent OR not a plain positive decimal integer — a lenient
 * `Number("9.5" | "0x10" | "1e3")` would otherwise silently honor
 * the truncated / hex / scientific interpretation instead of
 * rejecting the typo. A valid value is clamped to `max`. Mirrors
 * the scheduler-routes strict-parse posture.
 */
export function parseHistoryLimit(raw: string | undefined, max: number): number | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!STRICT_INT_RE.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(max, parsed);
}

export function parseResponseLocales(raw: string | undefined): readonly string[] {
  const fallback = ["ko", "en"];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry === "ko" || entry === "en");
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}
