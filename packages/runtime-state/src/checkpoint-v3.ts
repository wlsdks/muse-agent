import { createHash } from "node:crypto";

import {
  isCanonicalLocalRunId,
  isCanonicalWorkspaceRealpath,
  type JsonObject
} from "@muse/shared";

import type { CheckpointContinuityEvidence, ExecutionCheckpoint } from "./index.js";

export const CHECKPOINT_V3_DIRECTORY = "v3";
export const CHECKPOINT_V3_SCHEMA_VERSION = 3;
const RUN_FILE_PREFIX_MAX_LENGTH = 180;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_QUERY_BYTES = 240;
const PHASES = new Set(["start", "act", "failed", "complete"]);

export interface SerializedCheckpointV3 {
  readonly continuityEvidence?: CheckpointContinuityEvidence;
  readonly createdAt: string;
  readonly id: string;
  readonly runId: string;
  readonly state: JsonObject;
  readonly step: number;
}

export interface CheckpointV3Envelope {
  readonly checkpoints: readonly SerializedCheckpointV3[];
  readonly provenance: {
    readonly runId: string;
    readonly workspaceRealpath: string;
  };
  readonly schemaVersion: 3;
}

function fileSafeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

export function checkpointV3FileName(workspaceRealpath: string, runId: string): string {
  const prefix = fileSafeSegment(runId).slice(0, RUN_FILE_PREFIX_MAX_LENGTH) || "run";
  const digest = createHash("sha256").update(JSON.stringify([workspaceRealpath, runId]), "utf8").digest("hex");
  return `${prefix}-${digest}.json`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let output = "";
  for (const character of value) {
    if (utf8Bytes(output + character) > maxBytes - 3) break;
    output += character;
  }
  return `${output}…`;
}

export function createCheckpointContinuityEvidence(query: unknown, phase: unknown): CheckpointContinuityEvidence | undefined {
  if (typeof query !== "string" || typeof phase !== "string" || !PHASES.has(phase)) return undefined;
  const normalized = query.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || CONTROL_PATTERN.test(normalized)) return undefined;
  return { phase: phase as CheckpointContinuityEvidence["phase"], query: truncateUtf8(normalized, MAX_QUERY_BYTES) };
}

export function serializeCheckpointV3(checkpoint: ExecutionCheckpoint, continuityEvidence?: CheckpointContinuityEvidence): SerializedCheckpointV3 {
  return {
    ...(continuityEvidence ? { continuityEvidence } : {}),
    createdAt: checkpoint.createdAt.toISOString(),
    id: checkpoint.id,
    runId: checkpoint.runId,
    state: checkpoint.state,
    step: checkpoint.step
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

function continuityEvidence(value: unknown): CheckpointContinuityEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["phase", "query"], ["phase", "query"])) return undefined;
  const projected = createCheckpointContinuityEvidence(record.query, record.phase);
  return projected && projected.query === record.query ? projected : undefined;
}

export function parseCheckpointV3Envelope(value: unknown): CheckpointV3Envelope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  if (!exactKeys(envelope, ["checkpoints", "provenance", "schemaVersion"], ["checkpoints", "provenance", "schemaVersion"]) || envelope.schemaVersion !== 3) return undefined;
  if (!envelope.provenance || typeof envelope.provenance !== "object" || Array.isArray(envelope.provenance)) return undefined;
  const provenance = envelope.provenance as Record<string, unknown>;
  if (!exactKeys(provenance, ["runId", "workspaceRealpath"], ["runId", "workspaceRealpath"])
    || !isCanonicalLocalRunId(provenance.runId)
    || !isCanonicalWorkspaceRealpath(provenance.workspaceRealpath)
    || provenance.workspaceRealpath === "/") return undefined;
  if (!Array.isArray(envelope.checkpoints) || envelope.checkpoints.length === 0 || envelope.checkpoints.length > 1_000) return undefined;
  const seen = new Set<number>();
  let previous = -1;
  const checkpoints: SerializedCheckpointV3[] = [];
  for (const item of envelope.checkpoints) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (!exactKeys(record, ["continuityEvidence", "createdAt", "id", "runId", "state", "step"], ["createdAt", "id", "runId", "state", "step"])) return undefined;
    if (!canonicalInstant(record.createdAt)
      || typeof record.id !== "string" || record.id.length === 0 || record.id !== record.id.trim() || CONTROL_PATTERN.test(record.id) || utf8Bytes(record.id) > 256
      || record.runId !== provenance.runId
      || typeof record.step !== "number" || !Number.isSafeInteger(record.step) || record.step < 0 || record.step <= previous || seen.has(record.step)
      || !record.state || typeof record.state !== "object" || Array.isArray(record.state)) return undefined;
    const evidence = record.continuityEvidence === undefined ? undefined : continuityEvidence(record.continuityEvidence);
    if (record.continuityEvidence !== undefined && !evidence) return undefined;
    seen.add(record.step);
    previous = record.step;
    checkpoints.push({
      ...(evidence ? { continuityEvidence: evidence } : {}),
      createdAt: record.createdAt,
      id: record.id,
      runId: record.runId,
      state: record.state as JsonObject,
      step: record.step
    });
  }
  return {
    checkpoints,
    provenance: { runId: provenance.runId, workspaceRealpath: provenance.workspaceRealpath },
    schemaVersion: CHECKPOINT_V3_SCHEMA_VERSION
  };
}

export function deserializeCheckpointV3(value: SerializedCheckpointV3): ExecutionCheckpoint {
  return { createdAt: new Date(value.createdAt), id: value.id, runId: value.runId, state: value.state, step: value.step };
}
