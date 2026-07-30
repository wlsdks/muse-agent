import { createHash } from "node:crypto";

import {
  normalizeTriggerControlState,
  type TriggerAdmissionJournalEntry,
  type TriggerControlState,
  type TriggerWorkState
} from "@muse/shared";

import type {
  GraphAssertion,
  GraphEvidenceRef,
  GraphPredicate,
  GraphRef
} from "./types.js";
import {
  evidenceRefKey,
  normalizeGraphAssertion
} from "./validation.js";

export const TRIGGER_CONTROL_LINEAGE_PROJECTION_RULE_VERSION =
  "trigger-control-lineage-projection-v1" as const;

export const TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES = Object.freeze({
  admission: "muse.trigger.admission-entry",
  work: "muse.trigger.work-state"
} as const);

export interface TriggerControlLineageProjectionScope {
  readonly dedupKey: string;
  readonly sourceId: string;
}

export interface TriggerControlLineageProjectionInput {
  readonly scope: TriggerControlLineageProjectionScope;
  readonly state: unknown;
}

export interface TriggerControlLineageProjection {
  readonly assertions: readonly GraphAssertion[];
  readonly ruleVersion:
    typeof TRIGGER_CONTROL_LINEAGE_PROJECTION_RULE_VERSION;
  readonly schemaVersion: 1;
  readonly scope: TriggerControlLineageProjectionScope;
  readonly sourceVersion: string;
}

export type TriggerControlLineageProjectionErrorCode =
  | "INVALID_SOURCE"
  | "INVALID_STATE"
  | "SCOPE_NOT_FOUND";

export class TriggerControlLineageProjectionError extends Error {
  constructor(
    readonly code: TriggerControlLineageProjectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TriggerControlLineageProjectionError";
  }
}

interface AssertionInput {
  readonly object: GraphRef;
  readonly predicate: GraphPredicate;
  readonly recordedAt: string;
  readonly sourceRefs: readonly GraphEvidenceRef[];
  readonly subject: GraphRef;
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_DEDUP_KEY_CHARACTERS = 512;
const MAX_SOURCE_ID_CHARACTERS = 128;
const MAX_ASSERTIONS = 3;

function fail(
  code: TriggerControlLineageProjectionErrorCode,
  message: string
): never {
  throw new TriggerControlLineageProjectionError(code, message);
}

function boundedText(
  value: unknown,
  label: string,
  maxCharacters: number
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maxCharacters
    || CONTROL_CHARACTERS.test(value)
  ) {
    fail("INVALID_SOURCE", `${label} must be bounded canonical text`);
  }
  return value;
}

function canonicalSourceId(value: unknown): string {
  const sourceId = boundedText(
    value,
    "trigger lineage sourceId",
    MAX_SOURCE_ID_CHARACTERS
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sourceId)) {
    fail("INVALID_SOURCE", "trigger lineage sourceId must be a logical identifier");
  }
  return sourceId;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    fail("INVALID_STATE", "trigger lineage source must contain finite numbers");
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  fail("INVALID_STATE", "trigger lineage source contains unsupported data");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function opaqueId(kind: string, material: unknown): string {
  return `muse-trigger-${kind}:${digest(material).slice("sha256:".length)}`;
}

function graphRef(
  kind: GraphRef["kind"],
  identity: unknown
): GraphRef {
  return Object.freeze({
    id: opaqueId(kind, identity),
    kind
  });
}

function sourceRef(
  namespace: string,
  sourceId: string,
  dedupKey: string,
  content: unknown
): GraphEvidenceRef {
  return Object.freeze({
    id: opaqueId("source", { dedupKey, namespace, sourceId }),
    namespace,
    version: digest(content)
  });
}

function sortedSourceRefs(
  refs: readonly GraphEvidenceRef[]
): readonly GraphEvidenceRef[] {
  return Object.freeze([...refs].sort((left, right) =>
    evidenceRefKey(left).localeCompare(evidenceRefKey(right))
  ));
}

function assertionId(value: unknown): string {
  return opaqueId("assertion", value);
}

function makeAssertion(input: AssertionInput): GraphAssertion {
  const body = {
    schemaVersion: 1 as const,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    epistemicClass: "source-observed" as const,
    sourceRefs: sortedSourceRefs(input.sourceRefs),
    recordedAt: input.recordedAt,
    derivation: {
      kind: "projection" as const,
      version: TRIGGER_CONTROL_LINEAGE_PROJECTION_RULE_VERSION
    }
  };
  return normalizeGraphAssertion({
    ...body,
    id: assertionId(body)
  });
}

function normalizeState(value: unknown): TriggerControlState {
  try {
    return normalizeTriggerControlState(value as TriggerControlState);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "invalid trigger control state";
    fail("INVALID_STATE", reason);
  }
}

function terminal(
  work: TriggerWorkState
): work is TriggerWorkState & {
  readonly status: "cancelled" | "completed" | "dead-lettered";
} {
  return work.status === "cancelled"
    || work.status === "completed"
    || work.status === "dead-lettered";
}

function entryRef(
  sourceId: string,
  entry: TriggerAdmissionJournalEntry
): GraphEvidenceRef {
  return sourceRef(
    TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES.admission,
    sourceId,
    entry.envelope.dedupKey,
    entry
  );
}

function workRef(
  sourceId: string,
  work: TriggerWorkState
): GraphEvidenceRef {
  return sourceRef(
    TRIGGER_CONTROL_LINEAGE_SOURCE_NAMESPACES.work,
    sourceId,
    work.dedupKey,
    work
  );
}

export function projectTriggerControlLineage(
  input: TriggerControlLineageProjectionInput
): TriggerControlLineageProjection {
  const sourceId = canonicalSourceId(input.scope?.sourceId);
  const dedupKey = boundedText(
    input.scope?.dedupKey,
    "trigger lineage dedupKey",
    MAX_DEDUP_KEY_CHARACTERS
  );
  const state = normalizeState(input.state);
  const entry = state.journal.entries.find((candidate) =>
    candidate.envelope.dedupKey === dedupKey
  );
  if (!entry) {
    fail("SCOPE_NOT_FOUND", "trigger lineage occurrence does not exist");
  }
  const work = state.workStates.find((candidate) =>
    candidate.dedupKey === dedupKey
  );
  const admissionSource = entryRef(sourceId, entry);
  const triggerEvidence = graphRef("evidence", {
    dedupKey,
    sourceId,
    type: "trigger-envelope"
  });
  const admissionDecision = graphRef("decision", {
    action: entry.decision.action,
    dedupKey,
    reasons: entry.decision.reasons,
    sourceId,
    type: "trigger-admission"
  });
  const assertions = [
    makeAssertion({
      object: admissionDecision,
      predicate: "PRECEDED",
      recordedAt: entry.admittedAt,
      sourceRefs: [admissionSource],
      subject: triggerEvidence
    })
  ];

  if (work) {
    const currentWorkSource = workRef(sourceId, work);
    const workAction = graphRef("action", {
      dedupKey,
      sourceId,
      type: "trigger-control-work"
    });
    assertions.push(makeAssertion({
      object: workAction,
      predicate: "PRECEDED",
      recordedAt: work.updatedAt,
      sourceRefs: [admissionSource, currentWorkSource],
      subject: admissionDecision
    }));
    if (terminal(work)) {
      const terminalEvidence = graphRef("evidence", {
        dedupKey,
        sourceId,
        status: work.status,
        type: "trigger-control-terminal"
      });
      assertions.push(makeAssertion({
        object: terminalEvidence,
        predicate: "PRECEDED",
        recordedAt: work.updatedAt,
        sourceRefs: [admissionSource, currentWorkSource],
        subject: workAction
      }));
    }
  }

  assertions.sort((left, right) => left.id.localeCompare(right.id));
  if (assertions.length > MAX_ASSERTIONS) {
    fail("INVALID_STATE", "trigger lineage projection exceeded its assertion bound");
  }
  const frozenAssertions = Object.freeze(assertions);
  const scope = Object.freeze({ dedupKey, sourceId });
  return Object.freeze({
    assertions: frozenAssertions,
    ruleVersion: TRIGGER_CONTROL_LINEAGE_PROJECTION_RULE_VERSION,
    schemaVersion: 1 as const,
    scope,
    sourceVersion: digest({ entry, work: work ?? null })
  });
}
