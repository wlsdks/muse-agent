import { createHash } from "node:crypto";

import {
  admitTrigger,
  type TriggerAdmissionDecision,
  type TriggerAdmissionInput,
  type TriggerAdmissionReason
} from "./trigger-admission.js";
import { isTriggerEnvelope, type TriggerEnvelope } from "./trigger-envelope.js";
import { assertPlainDataTree, isRecord, type JsonValue } from "./json-utils.js";
import { parseStrictJson } from "./strict-json.js";

export const TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION = 1 as const;

export type TriggerAdmissionJournalState =
  | "cancelled"
  | "completed"
  | "dead-lettered"
  | "queued"
  | "rejected"
  | "shadowed";

export interface TriggerAdmissionJournalEntry {
  readonly admittedAt: string;
  readonly decision: TriggerAdmissionDecision;
  readonly envelope: TriggerEnvelope;
  readonly settledAt?: string;
  readonly state: TriggerAdmissionJournalState;
  readonly terminalReason?: string;
}

export interface TriggerAdmissionJournal {
  readonly entries: readonly TriggerAdmissionJournalEntry[];
  readonly maxEntries: number;
  readonly maxPending: number;
  readonly overflowCount: number;
  readonly schemaVersion: typeof TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION;
  readonly snapshotId: string;
}

export interface CreateTriggerAdmissionJournalInput {
  readonly maxEntries?: number;
  readonly maxPending: number;
}

export interface JournalTriggerAdmissionInput
  extends Omit<TriggerAdmissionInput, "budgetAvailable" | "seenDedupKeys"> {
  readonly budgetAvailable?: boolean;
}

export interface JournalTriggerAdmissionResult {
  readonly decision: TriggerAdmissionDecision;
  readonly journal: TriggerAdmissionJournal;
  readonly recorded: boolean;
}

export interface SettleTriggerAdmissionInput {
  readonly at: Date;
  readonly dedupKey: string;
  readonly outcome: "cancelled" | "completed" | "dead-lettered";
  readonly reason?: string;
}

const DEFAULT_MAX_ENTRIES = 4_096;
const MAX_JOURNAL_ENTRIES = DEFAULT_MAX_ENTRIES;
const SNAPSHOT_ID_PREFIX = "trigger-journal:";
const trustedJournals = new WeakSet<object>();
const ADMISSION_REASONS = new Set<TriggerAdmissionReason>([
  "budget-exhausted",
  "cooldown-active",
  "delivery-brake",
  "duplicate",
  "focus-inactive",
  "focus-unknown",
  "future",
  "invalid",
  "irrelevant",
  "paused",
  "permission-denied",
  "permission-unknown",
  "quiet-hours",
  "relevance-unknown",
  "shadow-only",
  "stale"
]);

export function createTriggerAdmissionJournal(
  input: CreateTriggerAdmissionJournalInput
): TriggerAdmissionJournal {
  const maxPending = positiveSafeInteger(input.maxPending, "maxPending");
  const maxEntries = positiveSafeInteger(input.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
  if (maxEntries < maxPending || maxEntries > MAX_JOURNAL_ENTRIES) {
    throw new TypeError(`maxEntries must be between maxPending and ${MAX_JOURNAL_ENTRIES}`);
  }
  return journalFromBody({
    entries: [],
    maxEntries,
    maxPending,
    overflowCount: 0,
    schemaVersion: TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION
  });
}

/**
 * Admits one exact trigger occurrence and atomically returns its next journal
 * snapshot. The host owns persistence; serializing the returned snapshot before
 * dispatch makes dedupe survive restarts without coupling this contract to I/O.
 */
export function admitTriggerToJournal(
  journal: TriggerAdmissionJournal,
  input: JournalTriggerAdmissionInput
): JournalTriggerAdmissionResult {
  const currentJournal = normalizeTriggerAdmissionJournal(journal);
  if (!isStrictTriggerEnvelope(input.envelope)) {
    return Object.freeze({
      decision: freezeDecision({ action: "reject", dedupKey: null, reasons: ["invalid"] }),
      journal: currentJournal,
      recorded: false
    });
  }
  const seenDedupKeys = new Set(currentJournal.entries.map((entry) => entry.envelope.dedupKey));
  const pending = currentJournal.entries.filter((entry) => entry.state === "queued").length;
  const decision = freezeDecision(admitTrigger({
    ...input,
    budgetAvailable: input.budgetAvailable !== false && pending < currentJournal.maxPending,
    seenDedupKeys
  }));

  if (decision.dedupKey === null || decision.reasons.includes("duplicate")) {
    return Object.freeze({ decision, journal: currentJournal, recorded: false });
  }

  const envelope = cloneEnvelope(input.envelope);
  const prunedEntries = makeEntrySpace(currentJournal.entries, currentJournal.maxEntries);
  if (prunedEntries === null) {
    const overflowDecision = freezeDecision({
      action: "shadow",
      dedupKey: envelope.dedupKey,
      reasons: decision.reasons.includes("budget-exhausted")
        ? decision.reasons
        : [...decision.reasons, "budget-exhausted"]
    });
    if (currentJournal.overflowCount === Number.MAX_SAFE_INTEGER) {
      throw new TypeError("trigger admission journal overflow counter exhausted");
    }
    const overflowJournal = journalFromBody({
      entries: currentJournal.entries,
      maxEntries: currentJournal.maxEntries,
      maxPending: currentJournal.maxPending,
      overflowCount: currentJournal.overflowCount + 1,
      schemaVersion: TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION
    });
    return Object.freeze({ decision: overflowDecision, journal: overflowJournal, recorded: false });
  }

  const entry = freezeEntry({
    admittedAt: canonicalTimestamp(input.now, "now"),
    decision,
    envelope,
    state: stateForDecision(decision)
  });
  const next = journalFromBody({
    entries: [...prunedEntries, entry],
    maxEntries: currentJournal.maxEntries,
    maxPending: currentJournal.maxPending,
    overflowCount: currentJournal.overflowCount,
    schemaVersion: TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION
  });
  return Object.freeze({ decision, journal: next, recorded: true });
}

export function settleTriggerAdmission(
  journal: TriggerAdmissionJournal,
  input: SettleTriggerAdmissionInput
): TriggerAdmissionJournal {
  const currentJournal = normalizeTriggerAdmissionJournal(journal);
  if (input.outcome !== "cancelled"
    && input.outcome !== "completed"
    && input.outcome !== "dead-lettered") {
    throw new TypeError("invalid trigger admission settlement outcome");
  }
  const index = currentJournal.entries.findIndex((entry) => entry.envelope.dedupKey === input.dedupKey);
  if (index < 0) {
    throw new TypeError("trigger admission entry not found");
  }
  const current = currentJournal.entries[index]!;
  if (current.state !== "queued") {
    throw new TypeError("only queued trigger admission entries can be settled");
  }
  const reason = input.reason?.trim();
  if ((input.outcome === "cancelled" || input.outcome === "dead-lettered") && !reason) {
    throw new TypeError(`${input.outcome} trigger admission entries require a reason`);
  }
  if (input.outcome === "completed" && reason) {
    throw new TypeError("completed trigger admission entries cannot have a terminal reason");
  }

  const settledAt = canonicalTimestamp(input.at, "at");
  if (Date.parse(settledAt) < Date.parse(current.admittedAt)) {
    throw new TypeError("settledAt cannot precede admittedAt");
  }
  const settled = freezeEntry({
    ...current,
    settledAt,
    state: input.outcome,
    ...(reason ? { terminalReason: reason } : {})
  });
  const entries = [...currentJournal.entries];
  entries[index] = settled;
  return journalFromBody({
    entries,
    maxEntries: currentJournal.maxEntries,
    maxPending: currentJournal.maxPending,
    overflowCount: currentJournal.overflowCount,
    schemaVersion: TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION
  });
}

export function serializeTriggerAdmissionJournal(journal: TriggerAdmissionJournal): string {
  return JSON.stringify(normalizeTriggerAdmissionJournal(journal));
}

export function parseTriggerAdmissionJournal(text: string): TriggerAdmissionJournal {
  const value = parseStrictJson(text, {
    maxArrayItems: MAX_JOURNAL_ENTRIES,
    maxDepth: 16,
    maxNodes: 65_536,
    maxObjectMembers: 16
  });
  if (!isRecord(value)
    || !hasExactKeys(value, [
      "entries",
      "maxEntries",
      "maxPending",
      "overflowCount",
      "schemaVersion",
      "snapshotId"
    ])
    || value.schemaVersion !== TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION
    || !Array.isArray(value.entries)
    || !isPositiveSafeInteger(value.maxEntries)
    || !isPositiveSafeInteger(value.maxPending)
    || value.maxEntries < value.maxPending
    || value.maxEntries > MAX_JOURNAL_ENTRIES
    || value.entries.length > value.maxEntries
    || !isNonNegativeSafeInteger(value.overflowCount)
    || typeof value.snapshotId !== "string") {
    throw new TypeError("invalid trigger admission journal");
  }

  const entries = value.entries.map(parseEntry);
  const keys = entries.map((entry) => entry.envelope.dedupKey);
  if (new Set(keys).size !== keys.length
    || entries.filter((entry) => entry.state === "queued").length > value.maxPending) {
    throw new TypeError("invalid trigger admission journal invariants");
  }
  const journal = journalFromBody({
    entries,
    maxEntries: value.maxEntries,
    maxPending: value.maxPending,
    overflowCount: value.overflowCount,
    schemaVersion: TRIGGER_ADMISSION_JOURNAL_SCHEMA_VERSION
  });
  if (journal.snapshotId !== value.snapshotId) {
    throw new TypeError("trigger admission journal integrity check failed");
  }
  return journal;
}

/**
 * Returns module-minted immutable snapshots without repeating an O(n) JSON
 * round-trip. Caller-created objects still traverse the strict parser and
 * content-integrity check before becoming trusted.
 */
export function normalizeTriggerAdmissionJournal(
  journal: TriggerAdmissionJournal
): TriggerAdmissionJournal {
  if (journal !== null && typeof journal === "object" && trustedJournals.has(journal)) {
    return journal;
  }
  assertPlainDataTree(journal, "triggerAdmissionJournal");
  return parseTriggerAdmissionJournal(JSON.stringify(journal));
}

type JournalBody = Omit<TriggerAdmissionJournal, "snapshotId">;

function journalFromBody(body: JournalBody): TriggerAdmissionJournal {
  const frozenBody = {
    entries: Object.freeze(body.entries.map(freezeEntry)),
    maxEntries: body.maxEntries,
    maxPending: body.maxPending,
    overflowCount: body.overflowCount,
    schemaVersion: body.schemaVersion
  };
  const snapshotId = `${SNAPSHOT_ID_PREFIX}${createHash("sha256")
    .update(JSON.stringify(frozenBody))
    .digest("hex")}`;
  const journal = Object.freeze({ ...frozenBody, snapshotId });
  trustedJournals.add(journal);
  return journal;
}

function parseEntry(value: JsonValue): TriggerAdmissionJournalEntry {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "admittedAt",
      "decision",
      "envelope",
      "settledAt",
      "state",
      "terminalReason"
    ])
    || !hasRequiredKeys(value, ["admittedAt", "decision", "envelope", "state"])
    || !isCanonicalTimestamp(value.admittedAt)
    || !isStrictTriggerEnvelope(value.envelope)
    || !isDecision(value.decision, value.envelope.dedupKey)
    || !isJournalState(value.state)) {
    throw new TypeError("invalid trigger admission journal entry");
  }
  const settledAt = value.settledAt;
  const terminalReason = value.terminalReason;
  const terminal = value.state === "cancelled"
    || value.state === "completed"
    || value.state === "dead-lettered";
  if (terminal !== (typeof settledAt === "string" && isCanonicalTimestamp(settledAt))
    || (typeof settledAt === "string" && Date.parse(settledAt) < Date.parse(value.admittedAt))
    || ((value.state === "cancelled" || value.state === "dead-lettered")
      && (typeof terminalReason !== "string" || terminalReason.trim() === ""))
    || (value.state !== "cancelled" && value.state !== "dead-lettered" && terminalReason !== undefined)
    || stateForDecision(value.decision) !== (terminal ? "queued" : value.state)) {
    throw new TypeError("invalid trigger admission journal entry state");
  }
  return freezeEntry({
    admittedAt: value.admittedAt,
    decision: value.decision,
    envelope: value.envelope,
    state: value.state,
    ...(typeof settledAt === "string" ? { settledAt } : {}),
    ...(typeof terminalReason === "string" ? { terminalReason } : {})
  });
}

function makeEntrySpace(
  entries: readonly TriggerAdmissionJournalEntry[],
  maxEntries: number
): readonly TriggerAdmissionJournalEntry[] | null {
  if (entries.length < maxEntries) return entries;
  const terminalIndex = entries.findIndex((entry) => entry.state !== "queued");
  if (terminalIndex < 0) return null;
  return entries.filter((_, index) => index !== terminalIndex);
}

function stateForDecision(decision: TriggerAdmissionDecision): TriggerAdmissionJournalState {
  if (decision.action === "execute") return "queued";
  return decision.action === "shadow" ? "shadowed" : "rejected";
}

function freezeEntry(entry: TriggerAdmissionJournalEntry): TriggerAdmissionJournalEntry {
  return Object.freeze({
    admittedAt: entry.admittedAt,
    decision: freezeDecision(entry.decision),
    envelope: cloneEnvelope(entry.envelope),
    ...(entry.settledAt !== undefined ? { settledAt: entry.settledAt } : {}),
    state: entry.state,
    ...(entry.terminalReason !== undefined ? { terminalReason: entry.terminalReason } : {})
  });
}

function freezeDecision(decision: TriggerAdmissionDecision): TriggerAdmissionDecision {
  return Object.freeze({
    action: decision.action,
    dedupKey: decision.dedupKey,
    reasons: Object.freeze([...decision.reasons])
  });
}

function cloneEnvelope(value: unknown): TriggerEnvelope {
  if (!isStrictTriggerEnvelope(value)) throw new TypeError("invalid trigger envelope");
  return deepFreeze(JSON.parse(JSON.stringify(value)) as TriggerEnvelope);
}

function isStrictTriggerEnvelope(value: unknown): value is TriggerEnvelope {
  if (!isRecord(value)
    || !isTriggerEnvelope(value)
    || !isRecord(value.provenance)
    || !hasOnlyKeys(value, [
      "dedupKey",
      "generation",
      "occurredAt",
      "payload",
      "provenance",
      "receivedAt",
      "schemaVersion",
      "source",
      "sourceId"
    ])
    || !hasRequiredKeys(value, [
      "dedupKey",
      "generation",
      "occurredAt",
      "provenance",
      "receivedAt",
      "schemaVersion",
      "source",
      "sourceId"
    ])
    || !hasOnlyKeys(value.provenance, ["kind", "ref"])
    || !hasRequiredKeys(value.provenance, ["kind"])) {
    return false;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isDecision(value: unknown, dedupKey: string): value is TriggerAdmissionDecision {
  return isRecord(value)
    && hasExactKeys(value, ["action", "dedupKey", "reasons"])
    && (value.action === "execute" || value.action === "reject" || value.action === "shadow")
    && value.dedupKey === dedupKey
    && Array.isArray(value.reasons)
    && value.reasons.every((reason) => typeof reason === "string" && ADMISSION_REASONS.has(reason as TriggerAdmissionReason))
    && (value.action === "execute" ? value.reasons.length === 0 : value.reasons.length > 0);
}

function isJournalState(value: unknown): value is TriggerAdmissionJournalState {
  return value === "cancelled"
    || value === "completed"
    || value === "dead-lettered"
    || value === "queued"
    || value === "rejected"
    || value === "shadowed";
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key));
}

function canonicalTimestamp(value: Date, field: string): string {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return value.toISOString();
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function positiveSafeInteger(value: number, field: string): number {
  if (!isPositiveSafeInteger(value)) throw new TypeError(`${field} must be a positive safe integer`);
  return value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
