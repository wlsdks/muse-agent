import { createHash } from "node:crypto";

import {
  parseTriggerAdmissionJournal,
  serializeTriggerAdmissionJournal,
  type TriggerAdmissionJournal
} from "./trigger-admission-journal.js";
import {
  parseTriggerWorkState,
  serializeTriggerWorkState,
  type TriggerWorkState
} from "./trigger-work-state.js";

export const LOOP_SUPERVISOR_HEALTH_SCHEMA_VERSION = 1 as const;

export type LoopHealthLevel = "blocked" | "degraded" | "healthy" | "unknown";

export interface AgentLoopHealthInput {
  readonly endedAt: string;
  readonly terminalReason: string;
  readonly terminalStatus: "cancelled" | "completed" | "failed" | "held";
  readonly verificationEvidenceId?: string;
  readonly verificationStatus: "failed" | "not-required" | "passed" | "pending";
}

export interface EventLoopHealthInput {
  readonly journal: TriggerAdmissionJournal;
  readonly workStates: readonly TriggerWorkState[];
}

export interface AdaptationLoopHealthInput {
  readonly evidenceId?: string;
  readonly evidenceVerified?: boolean;
  readonly status: "eligible" | "idle" | "paused" | "promoted" | "rejected" | "rolled-back" | "shadowing";
}

export interface CreateLoopSupervisorHealthInput {
  readonly adaptation?: AdaptationLoopHealthInput;
  readonly agent?: AgentLoopHealthInput;
  readonly event?: EventLoopHealthInput;
  readonly generatedAt: Date;
  readonly staleAfterMs?: number;
}

export interface LoopComponentHealth {
  readonly level: LoopHealthLevel;
  readonly reasons: readonly string[];
}

export interface EventLoopComponentHealth extends LoopComponentHealth {
  readonly counts: Readonly<{
    readonly cancelled: number;
    readonly completed: number;
    readonly deadLettered: number;
    readonly leased: number;
    readonly queued: number;
    readonly rejected: number;
    readonly retryWait: number;
    readonly shadowed: number;
  }>;
  readonly overflowCount: number;
}

export interface LoopSupervisorHealthSnapshot {
  readonly adaptation: LoopComponentHealth;
  readonly agent: LoopComponentHealth;
  readonly event: EventLoopComponentHealth;
  readonly generatedAt: string;
  readonly level: LoopHealthLevel;
  readonly reasons: readonly string[];
  readonly schemaVersion: typeof LOOP_SUPERVISOR_HEALTH_SCHEMA_VERSION;
  readonly snapshotId: string;
}

const SNAPSHOT_ID_PREFIX = "loop-health:";
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

export function createLoopSupervisorHealthSnapshot(
  input: CreateLoopSupervisorHealthInput
): LoopSupervisorHealthSnapshot {
  const generatedAt = canonicalTimestamp(input.generatedAt, "generatedAt");
  const staleAfterMs = nonNegativeSafeInteger(
    input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    "staleAfterMs"
  );
  const agent = agentHealth(input.agent, generatedAt, staleAfterMs);
  const event = eventHealth(input.event, generatedAt);
  const adaptation = adaptationHealth(input.adaptation);
  const components = [agent, event, adaptation];
  const reasons = new Set<string>();
  let level: LoopHealthLevel;

  if (components.some((component) => component.level === "blocked")) {
    level = "blocked";
  } else if (components.every((component) => component.level === "unknown")) {
    level = "unknown";
  } else if (components.some((component) =>
    component.level === "degraded" || component.level === "unknown")) {
    level = "degraded";
    if (components.some((component) => component.level === "unknown")) {
      reasons.add("partial-observability");
    }
  } else {
    level = "healthy";
  }
  for (const component of components) {
    for (const reason of component.reasons) reasons.add(reason);
  }

  const body = {
    adaptation,
    agent,
    event,
    generatedAt,
    level,
    reasons: Object.freeze([...reasons].sort()),
    schemaVersion: LOOP_SUPERVISOR_HEALTH_SCHEMA_VERSION
  };
  const snapshotId = `${SNAPSHOT_ID_PREFIX}${createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex")}`;
  return deepFreeze({ ...body, snapshotId });
}

function agentHealth(
  input: AgentLoopHealthInput | undefined,
  generatedAt: string,
  staleAfterMs: number
): LoopComponentHealth {
  if (!input) return component("unknown", ["agent-evidence-missing"]);
  if (!isCanonicalTimestamp(input.endedAt)
    || !isTerminalStatus(input.terminalStatus)
    || typeof input.terminalReason !== "string"
    || input.terminalReason.trim() === ""
    || !isVerificationStatus(input.verificationStatus)
    || ((input.verificationStatus === "passed" || input.verificationStatus === "failed")
      ? typeof input.verificationEvidenceId !== "string" || input.verificationEvidenceId.trim() === ""
      : input.verificationEvidenceId !== undefined)) {
    throw new TypeError("invalid agent loop health input");
  }
  if (input.terminalStatus === "completed"
    && (input.terminalReason !== "goal-verified"
      || (input.verificationStatus !== "passed" && input.verificationStatus !== "not-required"))) {
    return component("blocked", ["agent-completion-unverified"]);
  }
  if (Date.parse(input.endedAt) > Date.parse(generatedAt)) {
    return component("blocked", ["agent-evidence-future"]);
  }
  if (input.verificationStatus === "failed") {
    return component("blocked", ["agent-verification-failed"]);
  }
  if (input.terminalStatus === "failed") {
    return component("blocked", [`agent-${input.terminalReason}`]);
  }
  if (input.terminalStatus === "held" || input.verificationStatus === "pending") {
    return component("degraded", [`agent-${input.terminalReason}`]);
  }
  if (input.terminalStatus === "cancelled") {
    return component("degraded", ["agent-cancelled"]);
  }
  if (input.verificationStatus === "not-required") {
    return component("degraded", ["agent-verification-not-required"]);
  }
  if (Date.parse(generatedAt) - Date.parse(input.endedAt) > staleAfterMs) {
    return component("degraded", ["agent-evidence-stale"]);
  }
  return component("healthy", []);
}

function eventHealth(
  input: EventLoopHealthInput | undefined,
  generatedAt: string
): EventLoopComponentHealth {
  if (!input) {
    return eventComponent("unknown", ["event-evidence-missing"], zeroEventCounts(), 0);
  }
  const journal = parseTriggerAdmissionJournal(
    serializeTriggerAdmissionJournal(input.journal)
  );
  const workStates = input.workStates.map((state) =>
    parseTriggerWorkState(serializeTriggerWorkState(state)));
  const workKeys = workStates.map((state) => state.dedupKey);
  if (new Set(workKeys).size !== workKeys.length) {
    throw new TypeError("duplicate event work state");
  }
  const journalKeys = new Set(journal.entries.map((entry) => entry.envelope.dedupKey));
  if (workStates.some((state) => !journalKeys.has(state.dedupKey))) {
    throw new TypeError("event work state has no admission entry");
  }
  for (const state of workStates) {
    const entry = journal.entries.find((candidate) => candidate.envelope.dedupKey === state.dedupKey)!;
    if (entry.state === "rejected" || entry.state === "shadowed"
      || (entry.state === "completed" && state.status !== "completed")
      || (entry.state === "dead-lettered" && state.status !== "dead-lettered")) {
      throw new TypeError("event work state contradicts admission journal");
    }
  }

  const deadLetterKeys = new Set([
    ...journal.entries
      .filter((entry) => entry.state === "dead-lettered")
      .map((entry) => entry.envelope.dedupKey),
    ...workStates
      .filter((state) => state.status === "dead-lettered")
      .map((state) => state.dedupKey)
  ]);
  const counts = {
    cancelled: workStates.filter((state) => state.status === "cancelled").length,
    completed: journal.entries.filter((entry) => entry.state === "completed").length,
    deadLettered: deadLetterKeys.size,
    leased: workStates.filter((state) => state.status === "leased").length,
    queued: journal.entries.filter((entry) => entry.state === "queued").length,
    rejected: journal.entries.filter((entry) => entry.state === "rejected").length,
    retryWait: workStates.filter((state) => state.status === "retry-wait").length,
    shadowed: journal.entries.filter((entry) => entry.state === "shadowed").length
  };
  const reasons = new Set<string>();
  let level: LoopHealthLevel = "healthy";
  const nowMs = Date.parse(generatedAt);
  if (journal.entries.some((entry) =>
    Date.parse(entry.admittedAt) > nowMs
      || (entry.settledAt !== undefined && Date.parse(entry.settledAt) > nowMs))
    || workStates.some((state) => Date.parse(state.updatedAt) > nowMs)) {
    level = "blocked";
    reasons.add("event-state-future");
  }
  if (counts.deadLettered > 0) {
    level = "blocked";
    reasons.add("event-dead-lettered");
  }
  if (workStates.some((state) =>
    state.status === "leased" && Date.parse(state.leaseExpiresAt!) <= nowMs)) {
    if (level !== "blocked") level = "degraded";
    reasons.add("event-lease-expired");
  }
  if (workStates.some((state) =>
    state.status === "retry-wait" && Date.parse(state.nextAttemptAt!) <= nowMs)) {
    if (level !== "blocked") level = "degraded";
    reasons.add("event-retry-due");
  }
  if (counts.cancelled > 0) {
    if (level !== "blocked") level = "degraded";
    reasons.add("event-cancelled");
  }
  if (workStates.some((state) => {
    const entry = journal.entries.find((candidate) =>
      candidate.envelope.dedupKey === state.dedupKey)!;
    return entry.state === "queued"
      && (state.status === "cancelled"
        || state.status === "completed"
        || state.status === "dead-lettered");
  })) {
    if (level !== "blocked") level = "degraded";
    reasons.add("event-settlement-pending");
  }
  if (counts.shadowed > 0 || journal.overflowCount > 0) {
    if (level !== "blocked") level = "degraded";
    reasons.add("event-backpressure");
  }
  return eventComponent(level, [...reasons], counts, journal.overflowCount);
}

function adaptationHealth(
  input: AdaptationLoopHealthInput | undefined
): LoopComponentHealth {
  if (!input) return component("unknown", ["adaptation-evidence-missing"]);
  if (!isAdaptationStatus(input.status)
    || (input.evidenceId !== undefined
      && (typeof input.evidenceId !== "string" || input.evidenceId.trim() === ""))
    || (input.evidenceVerified !== undefined && typeof input.evidenceVerified !== "boolean")) {
    throw new TypeError("invalid adaptation loop health input");
  }
  if (input.status === "promoted") {
    return input.evidenceId && input.evidenceVerified === true
      ? component("healthy", [])
      : component("blocked", ["adaptation-promotion-unverified"]);
  }
  if (input.evidenceId !== undefined || input.evidenceVerified !== undefined) {
    throw new TypeError("adaptation evidence is only valid for promoted status");
  }
  if (input.status === "paused") return component("degraded", ["adaptation-paused"]);
  if (input.status === "rejected") return component("degraded", ["adaptation-rejected"]);
  if (input.status === "rolled-back") return component("degraded", ["adaptation-rolled-back"]);
  return component("healthy", []);
}

function component(level: LoopHealthLevel, reasons: readonly string[]): LoopComponentHealth {
  return Object.freeze({ level, reasons: Object.freeze([...reasons].sort()) });
}

function eventComponent(
  level: LoopHealthLevel,
  reasons: readonly string[],
  counts: EventLoopComponentHealth["counts"],
  overflowCount: number
): EventLoopComponentHealth {
  return Object.freeze({
    counts: Object.freeze({ ...counts }),
    level,
    overflowCount,
    reasons: Object.freeze([...reasons].sort())
  });
}

function zeroEventCounts(): EventLoopComponentHealth["counts"] {
  return Object.freeze({
    cancelled: 0,
    completed: 0,
    deadLettered: 0,
    leased: 0,
    queued: 0,
    rejected: 0,
    retryWait: 0,
    shadowed: 0
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function isTerminalStatus(value: unknown): value is AgentLoopHealthInput["terminalStatus"] {
  return value === "cancelled" || value === "completed" || value === "failed" || value === "held";
}

function isVerificationStatus(value: unknown): value is AgentLoopHealthInput["verificationStatus"] {
  return value === "failed" || value === "not-required" || value === "passed" || value === "pending";
}

function isAdaptationStatus(value: unknown): value is AdaptationLoopHealthInput["status"] {
  return value === "eligible"
    || value === "idle"
    || value === "paused"
    || value === "promoted"
    || value === "rejected"
    || value === "rolled-back"
    || value === "shadowing";
}
