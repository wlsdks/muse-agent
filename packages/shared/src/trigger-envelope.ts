import { createHash } from "node:crypto";

import { isRecord, type JsonValue } from "./json-data.js";

export const TRIGGER_ENVELOPE_SCHEMA_VERSION = 1 as const;

export type TriggerSource = "cron" | "manual" | "reminder" | "webhook";

export type TriggerProvenanceKind =
  | "capability-token"
  | "local-scheduler"
  | "local-store"
  | "owner-command";

export interface TriggerProvenance {
  readonly kind: TriggerProvenanceKind;
  /** Stable local reference only; never a credential or raw capability token. */
  readonly ref?: string;
}

/**
 * Provider-neutral identity and timing for one exact event occurrence.
 * `occurredAt` describes the source event; `receivedAt` describes admission
 * into Muse. The payload remains untrusted data and is never authority.
 */
export interface TriggerEnvelope {
  readonly dedupKey: string;
  readonly generation: string;
  readonly occurredAt: string;
  readonly payload?: JsonValue;
  readonly provenance: TriggerProvenance;
  readonly receivedAt: string;
  readonly schemaVersion: typeof TRIGGER_ENVELOPE_SCHEMA_VERSION;
  readonly source: TriggerSource;
  readonly sourceId: string;
}

export interface CreateTriggerEnvelopeInput {
  readonly generation: string;
  readonly occurredAt: Date | string;
  readonly payload?: JsonValue;
  readonly provenance?: TriggerProvenance;
  readonly receivedAt: Date | string;
  readonly source: TriggerSource;
  readonly sourceId: string;
}

const DEFAULT_PROVENANCE: Readonly<Record<TriggerSource, TriggerProvenanceKind>> = {
  cron: "local-scheduler",
  manual: "owner-command",
  reminder: "local-store",
  webhook: "capability-token"
};

export function createTriggerEnvelope(input: CreateTriggerEnvelopeInput): TriggerEnvelope {
  const sourceId = requireNonEmpty(input.sourceId, "sourceId");
  const generation = requireNonEmpty(input.generation, "generation");
  const occurredAt = canonicalTimestamp(input.occurredAt, "occurredAt");
  const receivedAt = canonicalTimestamp(input.receivedAt, "receivedAt");
  const dedupKey = canonicalTriggerDedupKey(input.source, sourceId, generation);
  return {
    dedupKey,
    generation,
    occurredAt,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    provenance: input.provenance ?? { kind: DEFAULT_PROVENANCE[input.source] },
    receivedAt,
    schemaVersion: TRIGGER_ENVELOPE_SCHEMA_VERSION,
    source: input.source,
    sourceId
  };
}

export function isTriggerEnvelope(value: unknown): value is TriggerEnvelope {
  if (!isRecord(value)
    || value.schemaVersion !== TRIGGER_ENVELOPE_SCHEMA_VERSION
    || !isTriggerSource(value.source)
    || typeof value.sourceId !== "string"
    || value.sourceId.trim().length === 0
    || typeof value.generation !== "string"
    || value.generation.trim().length === 0
    || typeof value.dedupKey !== "string"
    || !isCanonicalTimestamp(value.occurredAt)
    || !isCanonicalTimestamp(value.receivedAt)
    || !isRecord(value.provenance)
    || !isTriggerProvenanceKind(value.provenance.kind)
    || value.provenance.kind !== DEFAULT_PROVENANCE[value.source]
    || !matchesTriggerDedupKey(value.source, value.sourceId.trim(), value.generation.trim(), value.dedupKey)) {
    return false;
  }
  if (value.provenance.ref !== undefined && typeof value.provenance.ref !== "string") {
    return false;
  }
  return value.payload === undefined || isJsonValue(value.payload);
}

function canonicalTriggerDedupKey(source: TriggerSource, sourceId: string, generation: string): string {
  return `trigger:${createHash("sha256")
    .update(JSON.stringify([source, sourceId, generation]))
    .digest("hex")}`;
}

function matchesTriggerDedupKey(
  source: TriggerSource,
  sourceId: string,
  generation: string,
  dedupKey: string
): boolean {
  if (dedupKey === canonicalTriggerDedupKey(source, sourceId, generation)) {
    return true;
  }
  // Reminder occurrences shipped before the shared envelope and already bind
  // durable outbound-effect receipts to this identity. Keep that exact format
  // valid while rejecting every other caller-supplied key.
  return source === "reminder"
    && dedupKey === `reminder:${createHash("sha256")
      .update(JSON.stringify([sourceId, generation]))
      .digest("hex")}`;
}

function canonicalTimestamp(value: Date | string, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
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

function isTriggerSource(value: unknown): value is TriggerSource {
  return value === "cron" || value === "manual" || value === "reminder" || value === "webhook";
}

function isTriggerProvenanceKind(value: unknown): value is TriggerProvenanceKind {
  return value === "capability-token"
    || value === "local-scheduler"
    || value === "local-store"
    || value === "owner-command";
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${field} must be non-empty`);
  }
  return normalized;
}
