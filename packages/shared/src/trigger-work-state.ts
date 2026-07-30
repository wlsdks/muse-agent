import { createHash } from "node:crypto";

import {
  normalizeTriggerAdmissionJournal,
  type TriggerAdmissionJournal
} from "./trigger-admission-journal.js";
import { assertPlainDataTree, isRecord, type JsonValue } from "./json-utils.js";
import { parseStrictJson } from "./strict-json.js";

export const TRIGGER_WORK_STATE_SCHEMA_VERSION = 1 as const;

export type TriggerWorkStatus =
  | "cancelled"
  | "completed"
  | "dead-lettered"
  | "leased"
  | "retry-wait";

export interface TriggerWorkState {
  readonly attempt: number;
  readonly dedupKey: string;
  readonly leaseExpiresAt?: string;
  readonly leaseToken?: string;
  readonly lastLeaseToken?: string;
  readonly maxAttempts: number;
  readonly nextAttemptAt?: string;
  readonly schemaVersion: typeof TRIGGER_WORK_STATE_SCHEMA_VERSION;
  readonly stateId: string;
  readonly status: TriggerWorkStatus;
  readonly terminalReason?: string;
  readonly updatedAt: string;
}

export interface ClaimTriggerWorkInput {
  readonly at: Date;
  readonly dedupKey: string;
  readonly leaseDurationMs: number;
  readonly leaseToken: string;
  readonly maxAttempts: number;
}

export interface ResumeTriggerWorkInput {
  readonly at: Date;
  readonly leaseDurationMs: number;
  readonly leaseToken: string;
}

export interface SettleTriggerWorkInput {
  readonly at: Date;
  readonly leaseToken: string;
  readonly outcome: "failed" | "succeeded";
  readonly reason?: string;
  readonly retryDelayMs?: number;
  readonly retryable?: boolean;
}

export interface CancelTriggerWorkInput {
  readonly at: Date;
  readonly leaseToken: string;
  readonly reason: string;
}

export interface ImportTerminalTriggerWorkStateInput {
  readonly dedupKey: string;
  readonly status: "cancelled" | "completed" | "dead-lettered";
  readonly terminalReason?: string;
  readonly updatedAt: string;
}

export interface ExpireFinalTriggerWorkLeaseInput {
  readonly at: Date;
}

const STATE_ID_PREFIX = "trigger-work:";
const trustedWorkStates = new WeakSet<object>();

export function claimTriggerWork(
  journal: TriggerAdmissionJournal,
  input: ClaimTriggerWorkInput
): TriggerWorkState {
  const admitted = normalizeTriggerAdmissionJournal(journal);
  const dedupKey = nonEmpty(input.dedupKey, "dedupKey");
  const entry = admitted.entries.find((candidate) => candidate.envelope.dedupKey === dedupKey);
  if (!entry) {
    throw new TypeError("trigger admission entry not found");
  }
  if (entry.state !== "queued") {
    throw new TypeError("only queued trigger admission entries can be claimed");
  }
  const at = canonicalTimestamp(input.at, "at");
  const maxAttempts = positiveSafeInteger(input.maxAttempts, "maxAttempts");
  return stateFromBody({
    attempt: 1,
    dedupKey,
    leaseExpiresAt: addDuration(at, input.leaseDurationMs, "leaseDurationMs"),
    leaseToken: nonEmpty(input.leaseToken, "leaseToken"),
    maxAttempts,
    schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
    status: "leased",
    updatedAt: at
  });
}

/**
 * Claims the next retry or fences an expired worker with a new lease token.
 * An expired final attempt becomes dead-lettered instead of being dispatched.
 */
export function resumeTriggerWork(
  state: TriggerWorkState,
  input: ResumeTriggerWorkInput
): TriggerWorkState {
  const current = normalizeTriggerWorkState(state);
  const at = canonicalTimestamp(input.at, "at");
  if (current.status !== "leased" && current.status !== "retry-wait") {
    throw new TypeError("only leased or retry-wait trigger work can be resumed");
  }
  const boundary = current.status === "leased"
    ? current.leaseExpiresAt!
    : current.nextAttemptAt!;
  if (Date.parse(at) < Date.parse(boundary)) {
    throw new TypeError(current.status === "leased"
      ? "trigger work lease is still active"
      : "trigger work retry is not due");
  }
  if (current.attempt >= current.maxAttempts) {
    return stateFromBody({
      attempt: current.attempt,
      dedupKey: current.dedupKey,
      maxAttempts: current.maxAttempts,
      schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
      status: "dead-lettered",
      terminalReason: current.status === "leased"
        ? "lease-expired"
        : "retry-budget-exhausted",
      updatedAt: at
    });
  }
  const leaseToken = nonEmpty(input.leaseToken, "leaseToken");
  const priorLeaseToken = current.status === "leased"
    ? current.leaseToken
    : current.lastLeaseToken;
  if (leaseToken === priorLeaseToken) {
    throw new TypeError("replacement trigger work lease token must be unique");
  }
  return stateFromBody({
    attempt: current.attempt + 1,
    dedupKey: current.dedupKey,
    leaseExpiresAt: addDuration(at, input.leaseDurationMs, "leaseDurationMs"),
    leaseToken,
    maxAttempts: current.maxAttempts,
    schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
    status: "leased",
    updatedAt: at
  });
}

export function settleTriggerWork(
  state: TriggerWorkState,
  input: SettleTriggerWorkInput
): TriggerWorkState {
  const current = normalizeTriggerWorkState(state);
  const at = canonicalTimestamp(input.at, "at");
  if (current.status !== "leased") {
    throw new TypeError("only leased trigger work can be settled");
  }
  if (nonEmpty(input.leaseToken, "leaseToken") !== current.leaseToken) {
    throw new TypeError("stale trigger work lease token");
  }
  if (Date.parse(at) >= Date.parse(current.leaseExpiresAt!)) {
    throw new TypeError("trigger work lease expired before settlement");
  }
  if (Date.parse(at) < Date.parse(current.updatedAt)) {
    throw new TypeError("trigger work settlement cannot precede lease");
  }
  if (input.outcome !== "failed" && input.outcome !== "succeeded") {
    throw new TypeError("invalid trigger work settlement outcome");
  }

  if (input.outcome === "succeeded") {
    if (input.reason !== undefined || input.retryable !== undefined || input.retryDelayMs !== undefined) {
      throw new TypeError("successful trigger work cannot include failure controls");
    }
    return stateFromBody({
      attempt: current.attempt,
      dedupKey: current.dedupKey,
      maxAttempts: current.maxAttempts,
      schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
      status: "completed",
      updatedAt: at
    });
  }

  const reason = nonEmpty(input.reason ?? "", "reason");
  if (input.retryable === true && current.attempt < current.maxAttempts) {
    return stateFromBody({
      attempt: current.attempt,
      dedupKey: current.dedupKey,
      lastLeaseToken: current.leaseToken,
      maxAttempts: current.maxAttempts,
      nextAttemptAt: addDuration(at, input.retryDelayMs ?? 0, "retryDelayMs", true),
      schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
      status: "retry-wait",
      updatedAt: at
    });
  }
  return stateFromBody({
    attempt: current.attempt,
    dedupKey: current.dedupKey,
    maxAttempts: current.maxAttempts,
    schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
    status: "dead-lettered",
    terminalReason: reason,
    updatedAt: at
  });
}

export function cancelTriggerWork(
  state: TriggerWorkState,
  input: CancelTriggerWorkInput
): TriggerWorkState {
  const current = normalizeTriggerWorkState(state);
  if (current.status !== "leased" && current.status !== "retry-wait") {
    throw new TypeError("only active trigger work can be cancelled");
  }
  const currentLeaseToken = current.status === "leased"
    ? current.leaseToken
    : current.lastLeaseToken;
  if (nonEmpty(input.leaseToken, "leaseToken") !== currentLeaseToken) {
    throw new TypeError("stale trigger work lease token");
  }
  const at = canonicalTimestamp(input.at, "at");
  if (Date.parse(at) < Date.parse(current.updatedAt)) {
    throw new TypeError("trigger work cancellation cannot precede current state");
  }
  return stateFromBody({
    attempt: current.attempt,
    dedupKey: current.dedupKey,
    maxAttempts: current.maxAttempts,
    schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
    status: "cancelled",
    terminalReason: nonEmpty(input.reason, "reason"),
    updatedAt: at
  });
}

/**
 * Reconstructs the minimal terminal work record required when upgrading a
 * settled admission journal into the composite control-state schema.
 *
 * Imported journal history has no attempt metadata, so the migration records
 * one historical attempt without inventing a lease or retry history.
 */
export function importTerminalTriggerWorkState(
  input: ImportTerminalTriggerWorkStateInput
): TriggerWorkState {
  const dedupKey = nonEmpty(input.dedupKey, "dedupKey");
  if (input.status !== "cancelled"
    && input.status !== "completed"
    && input.status !== "dead-lettered") {
    throw new TypeError("imported trigger work must be terminal");
  }
  if (!isCanonicalTimestamp(input.updatedAt)) {
    throw new TypeError("updatedAt must be a canonical timestamp");
  }
  const terminalReason = input.status === "completed"
    ? undefined
    : nonEmpty(input.terminalReason ?? "", "terminalReason");
  if (input.status === "completed" && input.terminalReason !== undefined) {
    throw new TypeError("completed trigger work cannot include a terminal reason");
  }
  return stateFromBody({
    attempt: 1,
    dedupKey,
    maxAttempts: 1,
    schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
    status: input.status,
    ...(terminalReason !== undefined ? { terminalReason } : {}),
    updatedAt: input.updatedAt
  });
}

/**
 * Converges an expired final-attempt lease after process loss without
 * redispatching its potentially non-idempotent external effect.
 */
export function expireFinalTriggerWorkLease(
  state: TriggerWorkState,
  input: ExpireFinalTriggerWorkLeaseInput
): TriggerWorkState {
  const current = normalizeTriggerWorkState(state);
  const at = canonicalTimestamp(input.at, "at");
  if (current.status !== "leased") {
    throw new TypeError("only leased trigger work can expire");
  }
  if (Date.parse(at) < Date.parse(current.leaseExpiresAt!)) {
    throw new TypeError("trigger work lease is still active");
  }
  if (current.attempt < current.maxAttempts) {
    throw new TypeError("trigger work lease still has retry budget");
  }
  return stateFromBody({
    attempt: current.attempt,
    dedupKey: current.dedupKey,
    maxAttempts: current.maxAttempts,
    schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
    status: "dead-lettered",
    terminalReason: "lease-expired",
    updatedAt: at
  });
}

export function serializeTriggerWorkState(state: TriggerWorkState): string {
  return JSON.stringify(normalizeTriggerWorkState(state));
}

export function parseTriggerWorkState(text: string): TriggerWorkState {
  const value = parseStrictJson(text, {
    maxArrayItems: 8,
    maxDepth: 4,
    maxNodes: 32,
    maxObjectMembers: 16
  });
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "attempt",
      "dedupKey",
      "leaseExpiresAt",
      "leaseToken",
      "lastLeaseToken",
      "maxAttempts",
      "nextAttemptAt",
      "schemaVersion",
      "stateId",
      "status",
      "terminalReason",
      "updatedAt"
    ])
    || !hasRequiredKeys(value, [
      "attempt",
      "dedupKey",
      "maxAttempts",
      "schemaVersion",
      "stateId",
      "status",
      "updatedAt"
    ])
    || value.schemaVersion !== TRIGGER_WORK_STATE_SCHEMA_VERSION
    || !isPositiveSafeInteger(value.attempt)
    || !isPositiveSafeInteger(value.maxAttempts)
    || value.attempt > value.maxAttempts
    || typeof value.dedupKey !== "string"
    || value.dedupKey.trim() === ""
    || typeof value.stateId !== "string"
    || !isWorkStatus(value.status)
    || !isCanonicalTimestamp(value.updatedAt)) {
    throw new TypeError("invalid trigger work state");
  }

  const body = parseBody(value);
  const state = stateFromBody(body);
  if (state.stateId !== value.stateId) {
    throw new TypeError("trigger work state integrity check failed");
  }
  return state;
}

export function normalizeTriggerWorkState(state: TriggerWorkState): TriggerWorkState {
  if (state !== null && typeof state === "object" && trustedWorkStates.has(state)) {
    return state;
  }
  assertPlainDataTree(state, "triggerWorkState");
  return parseTriggerWorkState(JSON.stringify(state));
}

type TriggerWorkStateBody = Omit<TriggerWorkState, "stateId">;

function parseBody(value: Record<string, JsonValue>): TriggerWorkStateBody {
  const status = value.status as TriggerWorkStatus;
  const leaseExpiresAt = value.leaseExpiresAt;
  const leaseToken = value.leaseToken;
  const lastLeaseToken = value.lastLeaseToken;
  const nextAttemptAt = value.nextAttemptAt;
  const terminalReason = value.terminalReason;
  const updatedAt = value.updatedAt as string;

  if (status === "leased") {
    if (!isCanonicalTimestamp(leaseExpiresAt)
      || Date.parse(leaseExpiresAt) <= Date.parse(updatedAt)
      || typeof leaseToken !== "string"
      || leaseToken.trim() === ""
      || lastLeaseToken !== undefined
      || nextAttemptAt !== undefined
      || terminalReason !== undefined) {
      throw new TypeError("invalid leased trigger work state");
    }
  } else if (status === "retry-wait") {
    if (!isCanonicalTimestamp(nextAttemptAt)
      || Date.parse(nextAttemptAt) < Date.parse(updatedAt)
      || (value.attempt as number) >= (value.maxAttempts as number)
      || leaseExpiresAt !== undefined
      || leaseToken !== undefined
      || typeof lastLeaseToken !== "string"
      || lastLeaseToken.trim() === ""
      || terminalReason !== undefined) {
      throw new TypeError("invalid retry-wait trigger work state");
    }
  } else {
    if (leaseExpiresAt !== undefined
      || leaseToken !== undefined
      || lastLeaseToken !== undefined
      || nextAttemptAt !== undefined) {
      throw new TypeError("invalid terminal trigger work state");
    }
    if ((status === "cancelled" || status === "dead-lettered")
      ? typeof terminalReason !== "string" || terminalReason.trim() === ""
      : terminalReason !== undefined) {
      throw new TypeError("invalid terminal trigger work reason");
    }
  }

  return {
    attempt: value.attempt as number,
    dedupKey: value.dedupKey as string,
    ...(typeof leaseExpiresAt === "string" ? { leaseExpiresAt } : {}),
    ...(typeof leaseToken === "string" ? { leaseToken } : {}),
    ...(typeof lastLeaseToken === "string" ? { lastLeaseToken } : {}),
    maxAttempts: value.maxAttempts as number,
    ...(typeof nextAttemptAt === "string" ? { nextAttemptAt } : {}),
    schemaVersion: TRIGGER_WORK_STATE_SCHEMA_VERSION,
    status,
    ...(typeof terminalReason === "string" ? { terminalReason } : {}),
    updatedAt
  };
}

function stateFromBody(body: TriggerWorkStateBody): TriggerWorkState {
  const stableBody = Object.freeze({ ...body });
  const stateId = `${STATE_ID_PREFIX}${createHash("sha256")
    .update(JSON.stringify(stableBody))
    .digest("hex")}`;
  const state = Object.freeze({ ...stableBody, stateId });
  trustedWorkStates.add(state);
  return state;
}

function addDuration(
  timestamp: string,
  durationMs: number,
  field: string,
  allowZero = false
): string {
  if (!Number.isSafeInteger(durationMs) || durationMs < (allowZero ? 0 : 1)) {
    throw new TypeError(`${field} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  const target = Date.parse(timestamp) + durationMs;
  const date = new Date(target);
  if (!Number.isSafeInteger(target) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} exceeds the timestamp range`);
  }
  return date.toISOString();
}

function canonicalTimestamp(value: Date, field: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return value.toISOString();
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be non-empty`);
  }
  return value.trim();
}

function positiveSafeInteger(value: number, field: string): number {
  if (!isPositiveSafeInteger(value)) throw new TypeError(`${field} must be a positive safe integer`);
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isWorkStatus(value: unknown): value is TriggerWorkStatus {
  return value === "cancelled"
    || value === "completed"
    || value === "dead-lettered"
    || value === "leased"
    || value === "retry-wait";
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}
