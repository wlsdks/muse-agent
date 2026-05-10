import type { AgentRunInput } from "@muse/agent-core";
import type { RuntimeSettingType } from "@muse/runtime-settings";

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is NonNullable<AgentRunInput["metadata"]> {
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

export function parseRuntimeSettingType(value: unknown): RuntimeSettingType | undefined {
  return value === "string" || value === "number" || value === "boolean" || value === "json"
    ? value
    : undefined;
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
