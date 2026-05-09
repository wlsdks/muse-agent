/**
 * Muse compat shared parser + JSON normalizer helpers extracted from
 * compat-routes.ts. Pure utilities with no Fastify reply
 * dependency — only FastifyRequest for query helpers.
 *
 * These helpers are imported by virtually every sibling compat module.
 */

import type { JsonObject } from "@muse/shared";
import type { FastifyRequest } from "fastify";

export type CompatBody = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value !== "number" || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isRecord(value) && Object.values(value).every(isJsonValue);
}

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

export function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

export function stringArrayField(value: unknown, fallback: string[]): string[] {
  const parsed = readStringArray(value);
  return parsed ? [...parsed] : fallback;
}

export function readStringSet(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
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

export function numberField(value: JsonObject, key: string): number {
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : 0;
}

export function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

export function readNullableNumber(value: unknown): number | undefined {
  const parsed = readNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function numberOrString(value: unknown, fallback: number): number | string {
  return typeof value === "string" && value.trim().length > 0 ? value : readNumber(value, fallback);
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value === "true" || value === "1";
  }

  return fallback;
}

export function containsIgnoreCase(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

export function readQueryString(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readQueryStringSet(request: FastifyRequest, key: string): Set<string> {
  const query = request.query as Record<string, unknown>;
  return new Set(readStringSet(query[key]));
}

export function readQueryInteger(request: FastifyRequest, key: string, fallback: number): number {
  const raw = readQueryString(request, key);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readQueryInstantMillis(request: FastifyRequest, key: string): number | undefined {
  const raw = readQueryString(request, key);

  if (!raw) {
    return undefined;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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

export function readNullableStringField(value: CompatBody, key: string): string | null {
  const item = value[key];
  return typeof item === "string" ? item : null;
}

export function readOptionalStringField(value: CompatBody, key: string, fallback: unknown): string | null {
  const item = value[key];
  return typeof item === "string" ? item : nullableStringResponse(fallback);
}

export function nullableStringResponse(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function nullableNumberResponse(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export function dateOrUndefined(value: unknown): Date | undefined {
  const millis = epochMillisOrNull(value);
  return millis === null ? undefined : new Date(millis);
}

export function dateOrNull(value: unknown): Date | null {
  return dateOrUndefined(value) ?? null;
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
