import { createHash } from "node:crypto";

import type {
  AttunementState,
  ExperienceLearningPolicyAudit,
  ExperienceLearningPromotionHandle
} from "@muse/attunement";
import {
  AttunementStateValidationError,
  parseAttunementState
} from "@muse/attunement/state-validation";

import { MAX_GRAPH_APPEND_BATCH_ASSERTIONS } from "@attunegraph/core";
import {
  deriveContinuityPolicyGraphRef,
  deriveExperienceLearningAuditEvidenceGraphRef,
  deriveExperienceLearningPolicyAuditSourceRef,
  deriveExperienceLearningPromotionEvidenceGraphRef,
  deriveExperienceLearningPromotionHandleSourceRef,
  experienceLearningPolicyAuditView,
  experienceLearningPromotionHandleView
} from "./continuity-projection-identity.js";
import type {
  GraphAssertion,
  GraphEvidenceRef,
  GraphPredicate,
  GraphRef
} from "@attunegraph/core";
import {
  evidenceRefKey,
  normalizeGraphAssertion
} from "@attunegraph/core/extension-kit";

export const EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION =
  "experience-learning-lineage-projection-v1" as const;

export interface ExperienceLearningLineageProjectionScope {
  readonly sourceId: string;
  readonly threadId: string;
}

export interface ExperienceLearningLineageProjectionInput {
  readonly scope: ExperienceLearningLineageProjectionScope;
  readonly state: unknown;
}

export interface ExperienceLearningLineageProjection {
  readonly assertions: readonly GraphAssertion[];
  readonly ruleVersion:
    typeof EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION;
  readonly schemaVersion: 1;
  readonly scope: ExperienceLearningLineageProjectionScope;
  readonly sourceVersion: string;
}

export type ExperienceLearningLineageProjectionErrorCode =
  | "INVALID_SOURCE"
  | "INVALID_STATE"
  | "PROJECTION_LIMIT"
  | "SCOPE_NOT_FOUND";

export class ExperienceLearningLineageProjectionError extends Error {
  constructor(
    readonly code: ExperienceLearningLineageProjectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExperienceLearningLineageProjectionError";
  }
}

interface AssertionInput {
  readonly object: GraphRef;
  readonly predicate: GraphPredicate;
  readonly recordedAt: string;
  readonly sourceRefs: readonly GraphEvidenceRef[];
  readonly subject: GraphRef;
  readonly validFrom: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_SOURCE_ID_CHARACTERS = 128;

function fail(
  code: ExperienceLearningLineageProjectionErrorCode,
  message: string
): never {
  throw new ExperienceLearningLineageProjectionError(code, message);
}

function safeSourceId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > MAX_SOURCE_ID_CHARACTERS
    || CONTROL_CHARACTERS.test(value)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    fail(
      "INVALID_SOURCE",
      "lineage projection sourceId must be a bounded logical identifier"
    );
  }
  return value;
}

function canonicalInstant(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("INVALID_SOURCE", `${label} must be a canonical ISO instant`);
  }
  return value;
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
    fail("INVALID_SOURCE", "lineage projection data must be finite");
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
  fail("INVALID_SOURCE", "lineage projection data is unsupported");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function assertionId(value: unknown): string {
  return `muse-learning-assertion:${digest(value).slice("sha256:".length)}`;
}

function sortedSourceRefs(
  refs: readonly GraphEvidenceRef[]
): readonly GraphEvidenceRef[] {
  return Object.freeze([...refs].sort((left, right) =>
    evidenceRefKey(left).localeCompare(evidenceRefKey(right))
  ));
}

function makeAssertion(input: AssertionInput): GraphAssertion {
  const body = {
    schemaVersion: 1 as const,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    epistemicClass: "source-observed" as const,
    sourceRefs: sortedSourceRefs(input.sourceRefs),
    validFrom: input.validFrom,
    recordedAt: input.recordedAt,
    derivation: {
      kind: "projection" as const,
      version: EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION
    }
  };
  return normalizeGraphAssertion({
    ...body,
    id: assertionId(body)
  });
}

function compareById<T extends { readonly id: string }>(
  left: T,
  right: T
): number {
  return left.id.localeCompare(right.id);
}

function addPromotionAssertions(
  target: GraphAssertion[],
  sourceId: string,
  handle: ExperienceLearningPromotionHandle,
  audit: ExperienceLearningPolicyAudit
): void {
  const recordedAt = canonicalInstant(handle.appliedAt, "promotion.appliedAt");
  const handleSource = deriveExperienceLearningPromotionHandleSourceRef(
    sourceId,
    handle
  );
  const auditSource = deriveExperienceLearningPolicyAuditSourceRef(
    sourceId,
    audit
  );
  const sourceRefs = [handleSource, auditSource];
  const promotedPolicy = deriveContinuityPolicyGraphRef(
    sourceId,
    handle.threadId,
    handle.policyAfter.version
  );
  const priorPolicy = deriveContinuityPolicyGraphRef(
    sourceId,
    handle.threadId,
    handle.policyBefore.version
  );
  const promotionEvidence =
    deriveExperienceLearningPromotionEvidenceGraphRef(
      sourceId,
      handle.handleId
    );
  const auditEvidence = deriveExperienceLearningAuditEvidenceGraphRef(
    sourceId,
    audit.id
  );
  target.push(
    makeAssertion({
      object: priorPolicy,
      predicate: "REVISION_OF",
      recordedAt,
      sourceRefs,
      subject: promotedPolicy,
      validFrom: recordedAt
    }),
    makeAssertion({
      object: promotionEvidence,
      predicate: "SUPPORTED_BY",
      recordedAt,
      sourceRefs,
      subject: promotedPolicy,
      validFrom: recordedAt
    }),
    makeAssertion({
      object: auditEvidence,
      predicate: "CORRELATES_WITH",
      recordedAt,
      sourceRefs,
      subject: promotionEvidence,
      validFrom: recordedAt
    })
  );
}

function addRollbackAssertions(
  target: GraphAssertion[],
  sourceId: string,
  handle: ExperienceLearningPromotionHandle,
  promotionAudit: ExperienceLearningPolicyAudit,
  rollbackAudit: ExperienceLearningPolicyAudit
): void {
  const recordedAt = canonicalInstant(
    rollbackAudit.occurredAt,
    "rollback.occurredAt"
  );
  const sourceRefs = [
    deriveExperienceLearningPromotionHandleSourceRef(sourceId, handle),
    deriveExperienceLearningPolicyAuditSourceRef(sourceId, promotionAudit),
    deriveExperienceLearningPolicyAuditSourceRef(sourceId, rollbackAudit)
  ];
  const restoredPolicy = deriveContinuityPolicyGraphRef(
    sourceId,
    rollbackAudit.threadId,
    rollbackAudit.policyAfter.version
  );
  const promotedPolicy = deriveContinuityPolicyGraphRef(
    sourceId,
    rollbackAudit.threadId,
    rollbackAudit.policyBefore.version
  );
  const rollbackEvidence = deriveExperienceLearningAuditEvidenceGraphRef(
    sourceId,
    rollbackAudit.id
  );
  const promotionEvidence =
    deriveExperienceLearningPromotionEvidenceGraphRef(
      sourceId,
      handle.handleId
    );
  target.push(
    makeAssertion({
      object: promotedPolicy,
      predicate: "REVISION_OF",
      recordedAt,
      sourceRefs,
      subject: restoredPolicy,
      validFrom: recordedAt
    }),
    makeAssertion({
      object: rollbackEvidence,
      predicate: "SUPPORTED_BY",
      recordedAt,
      sourceRefs,
      subject: restoredPolicy,
      validFrom: recordedAt
    }),
    makeAssertion({
      object: promotionEvidence,
      predicate: "CORRELATES_WITH",
      recordedAt,
      sourceRefs,
      subject: rollbackEvidence,
      validFrom: recordedAt
    })
  );
}

export function projectExperienceLearningLineage(
  input: ExperienceLearningLineageProjectionInput
): ExperienceLearningLineageProjection {
  const sourceId = safeSourceId(input.scope?.sourceId);
  let state: AttunementState;
  try {
    state = parseAttunementState(input.state);
  } catch (cause) {
    if (cause instanceof AttunementStateValidationError) {
      fail("INVALID_STATE", cause.message);
    }
    throw cause;
  }
  const thread = state.threads.find((candidate) =>
    candidate.id === input.scope?.threadId
  );
  if (!thread) {
    fail(
      "SCOPE_NOT_FOUND",
      `lineage projection thread '${String(input.scope?.threadId)}' does not exist`
    );
  }
  const scope = Object.freeze({ sourceId, threadId: thread.id });
  const audits = (state.experienceLearningPolicyAudits ?? [])
    .filter((audit) => audit.threadId === thread.id)
    .sort(compareById);
  const auditById = new Map(audits.map((audit) => [audit.id, audit]));
  const handles = (state.experienceLearningPromotionHandles ?? [])
    .filter((handle) => handle.threadId === thread.id)
    .sort((left, right) => left.handleId.localeCompare(right.handleId));
  const handleByPromotionAudit = new Map(
    handles.map((handle) => [handle.promotionAuditId, handle])
  );
  const rollbackAudits = audits.filter((audit) =>
    audit.kind === "rollback" && handleByPromotionAudit.has(audit.sourceId)
  );
  const assertions: GraphAssertion[] = [];
  for (const handle of handles) {
    const audit = auditById.get(handle.promotionAuditId);
    if (!audit || audit.kind !== "promotion") {
      fail(
        "INVALID_STATE",
        `promotion handle '${handle.handleId}' has no promotion audit`
      );
    }
    addPromotionAssertions(assertions, sourceId, handle, audit);
  }
  for (const rollbackAudit of rollbackAudits) {
    const promotionAudit = auditById.get(rollbackAudit.sourceId);
    const handle = handleByPromotionAudit.get(rollbackAudit.sourceId);
    if (!promotionAudit || !handle) {
      fail(
        "INVALID_STATE",
        `rollback audit '${rollbackAudit.id}' has no promotion lineage`
      );
    }
    addRollbackAssertions(
      assertions,
      sourceId,
      handle,
      promotionAudit,
      rollbackAudit
    );
  }
  assertions.sort(compareById);
  if (assertions.length > MAX_GRAPH_APPEND_BATCH_ASSERTIONS) {
    fail(
      "PROJECTION_LIMIT",
      `lineage projection exceeds ${MAX_GRAPH_APPEND_BATCH_ASSERTIONS.toString()} assertions`
    );
  }
  const frozenAssertions = Object.freeze(assertions);
  const sourceVersion = digest({
    handles: handles.map(experienceLearningPromotionHandleView),
    promotionAudits: handles.map((handle) =>
      experienceLearningPolicyAuditView(
        auditById.get(handle.promotionAuditId)!
      )),
    rollbackAudits: rollbackAudits.map(experienceLearningPolicyAuditView)
  });
  return Object.freeze({
    assertions: frozenAssertions,
    ruleVersion: EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION,
    schemaVersion: 1 as const,
    scope,
    sourceVersion
  });
}
