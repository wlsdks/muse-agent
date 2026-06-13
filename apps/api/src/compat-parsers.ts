/**
 * Muse compat shared parser + JSON normalizer helpers extracted from
 * compat-routes.ts. Pure utilities with no Fastify reply
 * dependency — only FastifyRequest for query helpers.
 *
 * These helpers are imported by virtually every sibling compat module.
 */

import type { JsonObject } from "@muse/shared";
import type { FastifyRequest } from "fastify";

import { isJsonValue, isRecord } from "./server-input-utils.js";

export type CompatBody = Record<string, unknown>;

// Re-exported so the compat-* sibling modules can keep importing
// `isRecord` from this hub without import-site edits. The truth lives
// in `./server-input-utils.js`, the canonical home for shape-inspection
// helpers across the API package.
export { isRecord };

export function toBody(value: unknown): CompatBody {
  return isRecord(value) ? value : {};
}

export function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).filter(([, item]) => isJsonValue(item))) as JsonObject;
}

export function jsonObjectField(value: unknown): JsonObject {
  return isRecord(value) ? toJsonObject(value) : {};
}

export function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function coerceStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

export function coerceStringSet(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )];
  }

  return typeof value === "string"
    ? [...new Set(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0))]
    : [];
}

export function stringMapField(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string")
  );
}

export function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

export function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value === "true" || value === "1";
  }

  return fallback;
}

export function readQueryString(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readQueryInteger(request: FastifyRequest, key: string, fallback: number): number {
  const raw = readQueryString(request, key);
  if (!raw) return fallback;
  const trimmed = raw.trim();
  // Strict parse, not Number.parseInt: a typo'd `?limit=20x` /
  // unit-slip `?days=7d` must reach the fallback, not silently
  // become 20 / 7.
  if (!/^[+-]?\d+$/u.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export function readQueryBoolean(request: FastifyRequest, key: string, fallback: boolean): boolean {
  const raw = readQueryString(request, key);

  if (raw === undefined) {
    return fallback;
  }

  return raw === "true" || raw === "1";
}

export function readAuthUserId(request: FastifyRequest): string | undefined {
  return (request as { auth?: { userId?: string } }).auth?.userId;
}

export function readBodyString(value: unknown, key: string): string | undefined {
  const body = toBody(value);
  const item = body[key];
  return typeof item === "string" && item.trim().length > 0 ? item : undefined;
}

export function readBodyNullableString(value: unknown, key: string): string | null | undefined {
  const item = toBody(value)[key];
  return item === null || typeof item === "string" ? item : undefined;
}

export function nullableStringResponse(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export function epochMillisOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function compatEnumString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toUpperCase()
    : fallback;
}

export function chunkText(content: string): readonly string[] {
  const maxChunkChars = 2_000;
  const chunks: string[] = [];

  for (let index = 0; index < content.length; index += maxChunkChars) {
    chunks.push(content.slice(index, index + maxChunkChars));
  }

  return chunks.length > 0 ? chunks : [content];
}
