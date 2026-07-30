import { createHash } from "node:crypto";

import {
  admitTriggerToJournal,
  createTriggerAdmissionJournal,
  normalizeTriggerAdmissionJournal,
  parseTriggerAdmissionJournal,
  settleTriggerAdmission,
  type CreateTriggerAdmissionJournalInput,
  type JournalTriggerAdmissionInput,
  type TriggerAdmissionJournal
} from "./trigger-admission-journal.js";
import type { TriggerAdmissionDecision } from "./trigger-admission.js";
import { assertPlainDataTree, isRecord } from "./json-utils.js";
import { parseStrictJson } from "./strict-json.js";
import {
  cancelTriggerWork,
  claimTriggerWork,
  normalizeTriggerWorkState,
  parseTriggerWorkState,
  resumeTriggerWork,
  settleTriggerWork,
  type CancelTriggerWorkInput,
  type ClaimTriggerWorkInput,
  type ResumeTriggerWorkInput,
  type SettleTriggerWorkInput,
  type TriggerWorkState
} from "./trigger-work-state.js";

export const TRIGGER_CONTROL_STATE_SCHEMA_VERSION = 1 as const;

export interface TriggerControlState {
  readonly journal: TriggerAdmissionJournal;
  readonly revision: number;
  readonly schemaVersion: typeof TRIGGER_CONTROL_STATE_SCHEMA_VERSION;
  readonly stateId: string;
  readonly workStates: readonly TriggerWorkState[];
}

export interface AdmitTriggerControlResult {
  readonly decision: TriggerAdmissionDecision;
  readonly recorded: boolean;
  readonly state: TriggerControlState;
}

export interface TriggerControlWorkInput {
  readonly dedupKey: string;
}

const STATE_ID_PREFIX = "trigger-control:";
const trustedControlStates = new WeakSet<object>();

export function createTriggerControlState(
  input: CreateTriggerAdmissionJournalInput
): TriggerControlState {
  return stateFromParts(createTriggerAdmissionJournal(input), [], 0);
}

export function admitTriggerControl(
  state: TriggerControlState,
  input: JournalTriggerAdmissionInput
): AdmitTriggerControlResult {
  const current = normalizeTriggerControlState(state);
  const result = admitTriggerToJournal(current.journal, input);
  if (result.journal.snapshotId === current.journal.snapshotId) {
    return Object.freeze({
      decision: result.decision,
      recorded: result.recorded,
      state: current
    });
  }
  const retainedKeys = new Set(result.journal.entries.map((entry) => entry.envelope.dedupKey));
  const workStates = current.workStates.filter((work) => retainedKeys.has(work.dedupKey));
  return Object.freeze({
    decision: result.decision,
    recorded: result.recorded,
    state: nextState(current, result.journal, workStates)
  });
}

export function claimTriggerControlWork(
  state: TriggerControlState,
  input: ClaimTriggerWorkInput
): TriggerControlState {
  const current = normalizeTriggerControlState(state);
  if (current.workStates.some((work) => work.dedupKey === input.dedupKey)) {
    throw new TypeError("trigger control work already exists");
  }
  const claimed = claimTriggerWork(current.journal, input);
  return nextState(current, current.journal, [...current.workStates, claimed]);
}

export function resumeTriggerControlWork(
  state: TriggerControlState,
  input: ResumeTriggerWorkInput & TriggerControlWorkInput
): TriggerControlState {
  const current = normalizeTriggerControlState(state);
  const work = requireWork(current, input.dedupKey);
  const resumed = resumeTriggerWork(work, input);
  const journal = resumed.status === "dead-lettered"
    ? settleJournalForWork(current.journal, resumed, input.at)
    : current.journal;
  return nextState(current, journal, replaceWork(current.workStates, resumed));
}

export function settleTriggerControlWork(
  state: TriggerControlState,
  input: SettleTriggerWorkInput & TriggerControlWorkInput
): TriggerControlState {
  const current = normalizeTriggerControlState(state);
  const settled = settleTriggerWork(requireWork(current, input.dedupKey), input);
  const journal = isTerminalWork(settled)
    ? settleJournalForWork(current.journal, settled, input.at)
    : current.journal;
  return nextState(current, journal, replaceWork(current.workStates, settled));
}

export function cancelTriggerControlWork(
  state: TriggerControlState,
  input: CancelTriggerWorkInput & TriggerControlWorkInput
): TriggerControlState {
  const current = normalizeTriggerControlState(state);
  const cancelled = cancelTriggerWork(requireWork(current, input.dedupKey), input);
  const journal = settleJournalForWork(current.journal, cancelled, input.at);
  return nextState(current, journal, replaceWork(current.workStates, cancelled));
}

export function serializeTriggerControlState(state: TriggerControlState): string {
  return JSON.stringify(normalizeTriggerControlState(state));
}

export function parseTriggerControlState(text: string): TriggerControlState {
  const value = parseStrictJson(text, {
    maxArrayItems: 4_096,
    maxDepth: 32,
    maxNodes: 262_144,
    maxObjectMembers: 16
  });
  if (!isRecord(value)
    || !hasExactKeys(value, ["journal", "revision", "schemaVersion", "stateId", "workStates"])
    || value.schemaVersion !== TRIGGER_CONTROL_STATE_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || typeof value.stateId !== "string"
    || !Array.isArray(value.workStates)) {
    throw new TypeError("invalid trigger control state");
  }
  const journal = parseTriggerAdmissionJournal(JSON.stringify(value.journal));
  const workStates = value.workStates.map((work) =>
    parseTriggerWorkState(JSON.stringify(work)));
  const state = stateFromParts(journal, workStates, value.revision as number);
  if (state.stateId !== value.stateId) {
    throw new TypeError("trigger control state integrity check failed");
  }
  return state;
}

export function normalizeTriggerControlState(state: TriggerControlState): TriggerControlState {
  if (state !== null && typeof state === "object" && trustedControlStates.has(state)) {
    return state;
  }
  assertPlainDataTree(state, "triggerControlState");
  return parseTriggerControlState(JSON.stringify(state));
}

function nextState(
  current: TriggerControlState,
  journal: TriggerAdmissionJournal,
  workStates: readonly TriggerWorkState[]
): TriggerControlState {
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    throw new TypeError("trigger control revision exhausted");
  }
  return stateFromParts(journal, workStates, current.revision + 1);
}

function stateFromParts(
  journalValue: TriggerAdmissionJournal,
  workValues: readonly TriggerWorkState[],
  revision: number
): TriggerControlState {
  const journal = normalizeTriggerAdmissionJournal(journalValue);
  const workStates = [...workValues]
    .map(normalizeTriggerWorkState)
    .sort((left, right) =>
      left.dedupKey < right.dedupKey ? -1 : left.dedupKey > right.dedupKey ? 1 : 0);
  assertCompositeInvariants(journal, workStates);
  const body = {
    journal,
    revision,
    schemaVersion: TRIGGER_CONTROL_STATE_SCHEMA_VERSION,
    workStates: Object.freeze(workStates)
  };
  const stateId = `${STATE_ID_PREFIX}${createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex")}`;
  const state = Object.freeze({ ...body, stateId });
  trustedControlStates.add(state);
  return state;
}

function assertCompositeInvariants(
  journal: TriggerAdmissionJournal,
  workStates: readonly TriggerWorkState[]
): void {
  const workByKey = new Map<string, TriggerWorkState>();
  for (const work of workStates) {
    if (workByKey.has(work.dedupKey)) throw new TypeError("duplicate trigger control work state");
    workByKey.set(work.dedupKey, work);
  }
  for (const entry of journal.entries) {
    const work = workByKey.get(entry.envelope.dedupKey);
    if (entry.state === "queued") {
      if (work && work.status !== "leased" && work.status !== "retry-wait") {
        throw new TypeError("queued trigger control entry has terminal work");
      }
      continue;
    }
    if (entry.state === "rejected" || entry.state === "shadowed") {
      if (work) throw new TypeError("non-executable trigger control entry has work");
      continue;
    }
    if (!work || work.status !== entry.state) {
      throw new TypeError("terminal trigger control state mismatch");
    }
  }
  const journalKeys = new Set(journal.entries.map((entry) => entry.envelope.dedupKey));
  if (workStates.some((work) => !journalKeys.has(work.dedupKey))) {
    throw new TypeError("orphan trigger control work state");
  }
}

function requireWork(state: TriggerControlState, dedupKey: string): TriggerWorkState {
  if (typeof dedupKey !== "string" || dedupKey.trim() === "") {
    throw new TypeError("dedupKey must be non-empty");
  }
  const work = state.workStates.find((candidate) => candidate.dedupKey === dedupKey);
  if (!work) throw new TypeError("trigger control work not found");
  return work;
}

function replaceWork(
  workStates: readonly TriggerWorkState[],
  replacement: TriggerWorkState
): readonly TriggerWorkState[] {
  return workStates.map((work) =>
    work.dedupKey === replacement.dedupKey ? replacement : work);
}

function isTerminalWork(
  work: TriggerWorkState
): work is TriggerWorkState & { readonly status: "completed" | "dead-lettered" } {
  return work.status === "completed" || work.status === "dead-lettered";
}

function settleJournalForWork(
  journal: TriggerAdmissionJournal,
  work: TriggerWorkState,
  at: Date
): TriggerAdmissionJournal {
  if (work.status === "completed") {
    return importSettle(journal, work, at, "completed");
  }
  if (work.status === "cancelled") {
    return importSettle(journal, work, at, "cancelled");
  }
  if (work.status === "dead-lettered") {
    return importSettle(journal, work, at, "dead-lettered");
  }
  throw new TypeError("trigger work is not terminal");
}

function importSettle(
  journal: TriggerAdmissionJournal,
  work: TriggerWorkState,
  at: Date,
  outcome: "cancelled" | "completed" | "dead-lettered"
): TriggerAdmissionJournal {
  // Kept behind a local indirection so every composite terminal transition has
  // exactly one journal settlement site.
  return settleTriggerAdmission(journal, {
    at,
    dedupKey: work.dedupKey,
    outcome,
    ...(work.terminalReason !== undefined ? { reason: work.terminalReason } : {})
  });
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const sorted = (actual as string[]).sort();
  const expected = [...keys].sort();
  return sorted.length === expected.length
    && sorted.every((key, index) => key === expected[index]);
}
