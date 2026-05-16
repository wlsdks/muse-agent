/**
 * Shared parsers used across the Muse ambient-tool builders. Kept
 * together so the per-domain extracts (`muse-tools-time.ts`,
 * future siblings for text/data) can import the same primitives
 * instead of re-implementing them.
 */

import type { JsonObject } from "@muse/shared";

export function readOptionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readRequiredDate(args: JsonObject, key: string): Date | undefined {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function readOptionalNumber(args: JsonObject, key: string): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export type OptionalDate =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "date"; readonly date: Date };

/**
 * Distinguishes "field absent" from "field present but unparseable"
 * for an optional ISO-8601 input. `readRequiredDate` collapses both
 * to `undefined`, so a tool that defaults a missing reference to
 * `now()` would silently anchor to the wrong instant when the caller
 * supplied a malformed (non-empty) value — a wrong answer with no
 * error. An empty string counts as absent (a model emitting `""`
 * for an unset optional means "not provided").
 */
export function readOptionalDate(args: JsonObject, key: string): OptionalDate {
  const value = args[key];
  if (value === undefined || value === null || (typeof value === "string" && value.length === 0)) {
    return { kind: "absent" };
  }
  if (typeof value !== "string") {
    return { kind: "invalid" };
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? { kind: "invalid" } : { kind: "date", date: parsed };
}
