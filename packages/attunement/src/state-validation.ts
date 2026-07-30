import {
  isCanonicalContactId,
  isCanonicalConversationId,
  isCanonicalWorkId
} from "@muse/stores";
import {
  decodeLocalCheckpointReference,
  decodeLocalRunReference,
  isRecord
} from "@muse/shared";

import { CONTINUITY_EVIDENCE_CLASSES } from "./evidence-provenance.js";
import { continuityOutcomeId } from "./outcome-id.js";
import { isValidExperienceLearningPolicyAudit } from "./experience-learning-policy-audit.js";
import { fingerprintContinuityPolicy } from "./policy-digest.js";
import {
  ARTIFACT_ROLES,
  ARTIFACT_TYPES,
  DETAIL_LEVELS,
  NEXT_STEP_PRESENTATIONS,
  OUTCOMES,
  SUPPRESSION_MODES,
  THREAD_KINDS,
  isCanonicalBrowsingVisitId,
  isCoherentArtifactProvider,
  isValidProviderId,
  type ArtifactLink,
  type ArtifactReference,
  type AttunementState,
  type ContinuityDelivery,
  type ContinuityInteractionAnchor,
  type ContinuityInteractionReceipt,
  type ExperienceLearningPolicyAudit,
  type PersonalThread,
  type PolicyResetReceipt,
  type UndoResetReceipt
} from "./types.js";

export class AttunementStateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttunementStateValidationError";
  }
}

function invalid(message: string): never {
  throw new AttunementStateValidationError(message);
}

function isOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T
): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isReference(value: unknown, schemaVersion = 11): value is ArtifactReference {
  return isRecord(value)
    && isNonEmptyString(value.artifactId)
    && isOneOf(value.artifactType, ARTIFACT_TYPES)
    && (schemaVersion >= 4 || value.artifactType !== "reminder")
    && (schemaVersion >= 5 || value.artifactType !== "calendar-event")
    && (schemaVersion >= 6 || value.artifactType !== "contact")
    && (schemaVersion >= 7 || value.artifactType !== "run")
    && (schemaVersion >= 8 || value.artifactType !== "checkpoint")
    && (schemaVersion >= 9 || value.artifactType !== "browsing-visit")
    && (schemaVersion >= 10 || value.artifactType !== "conversation")
    && (schemaVersion >= 11 || value.artifactType !== "work")
    && (value.artifactType !== "contact" || isCanonicalContactId(value.artifactId))
    && (value.artifactType !== "run"
      || decodeLocalRunReference(value.artifactId) !== undefined)
    && (value.artifactType !== "checkpoint"
      || decodeLocalCheckpointReference(value.artifactId) !== undefined)
    && (value.artifactType !== "browsing-visit"
      || isCanonicalBrowsingVisitId(value.artifactId))
    && (value.artifactType !== "conversation"
      || isCanonicalConversationId(value.artifactId))
    && (value.artifactType !== "work" || isCanonicalWorkId(value.artifactId))
    && isValidProviderId(value.providerId)
    && isCoherentArtifactProvider(value.artifactType, value.providerId)
    && isOneOf(value.role, ARTIFACT_ROLES);
}

function isLink(value: unknown, schemaVersion = 11): value is ArtifactLink {
  if (!isRecord(value) || !isReference(value, schemaVersion)) return false;
  return isNonEmptyString(value.linkedAt)
    && value.linkedBy === "user"
    && isNonEmptyString(value.threadId);
}

function isPolicy(value: unknown): value is PersonalThread["policy"] {
  return isRecord(value)
    && isOneOf(value.detail, DETAIL_LEVELS)
    && isOneOf(value.nextStep, NEXT_STEP_PRESENTATIONS)
    && isOneOf(value.suppression, SUPPRESSION_MODES)
    && isSafeVersion(value.version);
}

function isThread(value: unknown, schemaVersion = 11): value is PersonalThread {
  return isRecord(value)
    && isNonEmptyString(value.createdAt)
    && isNonEmptyString(value.id)
    && isOneOf(value.kind, THREAD_KINDS)
    && Array.isArray(value.links)
    && value.links.every((link) => isLink(link, schemaVersion))
    && isPolicy(value.policy)
    && isNonEmptyString(value.title);
}

function isEvidenceClass(value: unknown): boolean {
  return isOneOf(value, CONTINUITY_EVIDENCE_CLASSES);
}

export function isContinuityOwnerNote(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && Array.from(value).length <= 500
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function isInteractionAnchor(value: unknown): value is ContinuityInteractionAnchor {
  return isRecord(value)
    && isNonEmptyString(value.artifactId)
    && isIsoTimestamp(value.linkedAt)
    && isIsoTimestamp(value.observedAt)
    && value.observedStatus === "open"
    && isFingerprint(value.openStateFingerprint)
    && value.providerId === "local"
    && value.role === "next-step";
}

function isDelivery(
  value: unknown,
  requireEvidenceClass = false,
  schemaVersion = 11
): value is ContinuityDelivery {
  if (!isRecord(value)
    || !Array.isArray(value.evidenceRefs)
    || !value.evidenceRefs.every((reference) => isReference(reference, schemaVersion))
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.openedAt)
    || (value.policyDigest !== undefined && !isFingerprint(value.policyDigest))
    || !isSafeVersion(value.policyVersion)
    || !isNonEmptyString(value.threadId)
    || (value.runId !== undefined && !isNonEmptyString(value.runId))
    || (requireEvidenceClass
      ? !isEvidenceClass(value.evidenceClass)
      : value.evidenceClass !== undefined && !isEvidenceClass(value.evidenceClass))
    || (value.interactionAnchor !== undefined
      && !isInteractionAnchor(value.interactionAnchor))) {
    return false;
  }
  if (value.outcome === undefined) return true;
  if (!isRecord(value.outcome)) return false;
  const ownerNote = value.outcome.ownerNote;
  if (!isOneOf(value.outcome.outcome, OUTCOMES)
    || (requireEvidenceClass
      ? !isEvidenceClass(value.outcome.evidenceClass)
      : value.outcome.evidenceClass !== undefined
        && !isEvidenceClass(value.outcome.evidenceClass))
    || (ownerNote === undefined
      ? false
      : !isContinuityOwnerNote(ownerNote))
    || !isSafeVersion(value.outcome.policyVersion)
    || !isNonEmptyString(value.outcome.recordedAt)) {
    return false;
  }
  const hasOwnerAuthority = value.outcome.authority !== undefined
    || value.outcome.id !== undefined;
  if (!hasOwnerAuthority) return true;
  if (value.outcome.authority !== "owner-explicit"
    || typeof value.outcome.id !== "string"
    || !isEvidenceClass(value.outcome.evidenceClass)) {
    return false;
  }
  return value.outcome.id === continuityOutcomeId({
    deliveryId: value.id,
    evidenceClass: value.outcome.evidenceClass as ContinuityDelivery["evidenceClass"],
    outcome: value.outcome.outcome,
    ...(typeof ownerNote === "string" ? { ownerNote } : {}),
    recordedAt: value.outcome.recordedAt,
    ...(typeof value.runId === "string" ? { runId: value.runId } : {})
  });
}

function isInteractionReceipt(
  value: unknown,
  requireEvidenceClass = false
): value is ContinuityInteractionReceipt {
  return isRecord(value)
    && isNonEmptyString(value.artifactId)
    && isIsoTimestamp(value.completedAt)
    && isNonEmptyString(value.deliveryId)
    && isFingerprint(value.doneStateFingerprint)
    && isNonEmptyString(value.eventId)
    && (requireEvidenceClass
      ? isEvidenceClass(value.evidenceClass)
      : value.evidenceClass === undefined || isEvidenceClass(value.evidenceClass))
    && isNonEmptyString(value.id)
    && isIsoTimestamp(value.linkedAt)
    && isFingerprint(value.openStateFingerprint)
    && value.providerId === "local"
    && isIsoTimestamp(value.recordedAt)
    && value.role === "next-step"
    && isNonEmptyString(value.runId)
    && isNonEmptyString(value.threadId)
    && value.transition === "open-to-done";
}

function isResetReceipt(value: unknown): value is PolicyResetReceipt {
  return isRecord(value)
    && isSafeVersion(value.basePolicyVersion)
    && isPolicy(value.beforePolicy)
    && isNonEmptyString(value.id)
    && isSafeVersion(value.resetPolicyVersion)
    && isNonEmptyString(value.threadId);
}

function isUndoResetReceipt(value: unknown): value is UndoResetReceipt {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && isSafeVersion(value.previousPolicyVersion)
    && isNonEmptyString(value.resetId)
    && isPolicy(value.restoredPolicy)
    && isNonEmptyString(value.threadId)
    && isNonEmptyString(value.undoneAt)
    && isSafeVersion(value.undoPolicyVersion);
}

function isExperienceLearningPolicyAudit(
  value: unknown
): value is ExperienceLearningPolicyAudit {
  return isRecord(value)
    && isFingerprint(value.activeBehaviorDigestAfter)
    && isFingerprint(value.activeBehaviorDigestBefore)
    && value.authority === "owner-explicit"
    && isNonEmptyString(value.candidateId)
    && isNonEmptyString(value.id)
    && (value.kind === "promotion" || value.kind === "rollback")
    && isIsoTimestamp(value.occurredAt)
    && isPolicy(value.policyAfter)
    && isPolicy(value.policyBefore)
    && isNonEmptyString(value.sourceId)
    && isNonEmptyString(value.threadId)
    && isValidExperienceLearningPolicyAudit(
      value as unknown as ExperienceLearningPolicyAudit
    );
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    invalid(`attunement store has duplicate ${label}`);
  }
}

function validateStateRelations(state: AttunementState): void {
  assertUnique(state.threads.map((thread) => thread.id), "thread ids");
  assertUnique(state.deliveries.map((delivery) => delivery.id), "delivery ids");
  assertUnique(
    state.deliveries.flatMap((delivery) => delivery.runId ? [delivery.runId] : []),
    "delivery run ids"
  );
  assertUnique(
    state.interactionReceipts.map((receipt) => receipt.id),
    "interaction receipt ids"
  );
  assertUnique(
    state.interactionReceipts.map((receipt) => receipt.eventId),
    "interaction event ids"
  );
  assertUnique(
    state.interactionReceipts.map((receipt) => receipt.deliveryId),
    "interaction delivery ids"
  );
  assertUnique(
    state.experienceLearningPolicyAudits.map((audit) => audit.id),
    "experience learning policy audit ids"
  );
  assertUnique(state.resetReceipts.map((receipt) => receipt.id), "reset receipt ids");
  assertUnique(
    state.undoResetReceipts.map((receipt) => receipt.id),
    "undo receipt ids"
  );

  const threads = new Map(state.threads.map((thread) => [thread.id, thread]));
  for (const thread of state.threads) {
    const linkKeys = thread.links.map((link) =>
      `${link.providerId}:${link.artifactType}:${link.artifactId}`
    );
    assertUnique(linkKeys, `artifact links on thread '${thread.id}'`);
    if (thread.links.some((link) => link.threadId !== thread.id)) {
      invalid(`attunement store has a link assigned to the wrong thread '${thread.id}'`);
    }
    const nextSteps = thread.links.filter((link) => link.role === "next-step");
    if (
      nextSteps.length > 1
      || nextSteps.some((link) => link.artifactType !== "task")
    ) {
      invalid(`attunement store has an invalid next-step on thread '${thread.id}'`);
    }
  }
  const workLinks = state.threads.flatMap((thread) =>
    thread.links.filter((link) => link.artifactType === "work")
  );
  assertUnique(
    workLinks.map((link) => link.artifactId),
    "Work artifact links across PersonalThreads"
  );

  const resetById = new Map(
    state.resetReceipts.map((receipt) => [receipt.id, receipt])
  );
  const generatedByThread = new Map<string, number[]>();
  const addVersion = (threadId: string, version: number): void => {
    const versions = generatedByThread.get(threadId) ?? [];
    versions.push(version);
    generatedByThread.set(threadId, versions);
  };

  for (const delivery of state.deliveries) {
    if (!threads.has(delivery.threadId)) {
      invalid(`delivery '${delivery.id}' references a missing thread`);
    }
    assertUnique(
      delivery.evidenceRefs.map((reference) =>
        `${reference.providerId}:${reference.artifactType}:${reference.artifactId}`
      ),
      `evidence refs on delivery '${delivery.id}'`
    );
    if (delivery.evidenceRefs.some((reference) =>
      reference.role === "next-step" && reference.artifactType !== "task"
    )) {
      invalid(`delivery '${delivery.id}' has a non-task next-step`);
    }
    if (delivery.interactionAnchor) {
      if (
        !delivery.runId
        || (Number.isFinite(Date.parse(delivery.openedAt))
          && delivery.interactionAnchor.observedAt !== delivery.openedAt)
        || !delivery.evidenceRefs.some((reference) =>
          reference.artifactId === delivery.interactionAnchor!.artifactId
          && reference.artifactType === "task"
          && reference.providerId === "local"
          && reference.role === "next-step"
        )
      ) {
        invalid(`delivery '${delivery.id}' has an invalid interaction anchor`);
      }
    }
    if (delivery.outcome) {
      if (delivery.outcome.policyVersion <= delivery.policyVersion) {
        invalid(
          `delivery '${delivery.id}' has an outcome at or before its delivery policy version`
        );
      }
      addVersion(delivery.threadId, delivery.outcome.policyVersion);
    }
  }

  const deliveriesById = new Map(
    state.deliveries.map((delivery) => [delivery.id, delivery])
  );
  for (const receipt of state.interactionReceipts) {
    const delivery = deliveriesById.get(receipt.deliveryId);
    const anchor = delivery?.interactionAnchor;
    if (
      !delivery
      || !anchor
      || !delivery.runId
      || receipt.artifactId !== anchor.artifactId
      || receipt.linkedAt !== anchor.linkedAt
      || receipt.openStateFingerprint !== anchor.openStateFingerprint
      || receipt.providerId !== anchor.providerId
      || receipt.role !== anchor.role
      || receipt.runId !== delivery.runId
      || receipt.threadId !== delivery.threadId
      || Date.parse(receipt.completedAt) <= Date.parse(delivery.openedAt)
    ) {
      invalid(`interaction receipt '${receipt.id}' has invalid delivery binding`);
    }
  }

  for (const receipt of state.resetReceipts) {
    if (!threads.has(receipt.threadId)) {
      invalid(`reset '${receipt.id}' references a missing thread`);
    }
    if (
      receipt.beforePolicy.version !== receipt.basePolicyVersion
      || receipt.resetPolicyVersion <= receipt.basePolicyVersion
    ) {
      invalid(`reset '${receipt.id}' has inconsistent policy versions`);
    }
    addVersion(receipt.threadId, receipt.resetPolicyVersion);
  }

  for (const receipt of state.undoResetReceipts) {
    const reset = resetById.get(receipt.resetId);
    if (!threads.has(receipt.threadId) || !reset || reset.threadId !== receipt.threadId) {
      invalid(`undo reset '${receipt.id}' references an invalid reset or thread`);
    }
    if (
      receipt.previousPolicyVersion !== reset.resetPolicyVersion
      || receipt.restoredPolicy.version !== receipt.undoPolicyVersion
      || receipt.undoPolicyVersion <= receipt.previousPolicyVersion
    ) {
      invalid(`undo reset '${receipt.id}' has inconsistent policy versions`);
    }
    addVersion(receipt.threadId, receipt.undoPolicyVersion);
  }

  const promotions = new Map(
    state.experienceLearningPolicyAudits
      .filter((audit) => audit.kind === "promotion")
      .map((audit) => [audit.id, audit])
  );
  for (const audit of state.experienceLearningPolicyAudits) {
    if (!threads.has(audit.threadId)) {
      invalid(`experience learning audit '${audit.id}' references a missing thread`);
    }
    if (audit.kind === "promotion" && audit.sourceId !== audit.candidateId) {
      invalid(`experience learning promotion audit '${audit.id}' has an invalid candidate binding`);
    }
    if (audit.kind === "rollback") {
      const promotion = promotions.get(audit.sourceId);
      if (!promotion
        || promotion.threadId !== audit.threadId
        || promotion.candidateId !== audit.candidateId
        || audit.activeBehaviorDigestBefore !== promotion.activeBehaviorDigestAfter
        || !samePolicy(audit.policyBefore, promotion.policyAfter)
        || Date.parse(audit.occurredAt) < Date.parse(promotion.occurredAt)) {
        invalid(`experience learning rollback audit '${audit.id}' has an invalid promotion binding`);
      }
    }
    addVersion(audit.threadId, audit.policyAfter.version);
  }

  const generatedVersions = [...generatedByThread.values()].flat();
  assertUnique(
    generatedVersions.map(String),
    "generated policy versions"
  );
  const maximumVersion = Math.max(
    0,
    ...generatedVersions,
    ...state.threads.map((thread) => thread.policy.version)
  );
  if (state.nextPolicyVersion <= maximumVersion) {
    invalid("attunement store has a non-monotonic next policy version");
  }
  for (const thread of state.threads) {
    const changes = generatedByThread.get(thread.id) ?? [];
    const expectedVersion = changes.length === 0 ? 0 : Math.max(...changes);
    if (thread.policy.version !== expectedVersion) {
      invalid(
        `thread '${thread.id}' has a policy version that does not match its receipts`
      );
    }
  }
  for (const delivery of state.deliveries) {
    const availableVersions = new Set([
      0,
      ...(generatedByThread.get(delivery.threadId) ?? [])
    ]);
    if (!availableVersions.has(delivery.policyVersion)) {
      invalid(`delivery '${delivery.id}' has an unknown policy version`);
    }
  }
}

function samePolicy(
  left: PersonalThread["policy"],
  right: PersonalThread["policy"]
): boolean {
  return left.detail === right.detail
    && left.nextStep === right.nextStep
    && left.suppression === right.suppression
    && left.version === right.version;
}

/**
 * I/O-free parser and normalizer shared by authoritative store reads/writes and
 * disposable projections. It is the only runtime boundary that upgrades unknown
 * input to an AttunementState.
 */
export function parseAttunementState(value: unknown): AttunementState {
  const schemaVersion = isRecord(value) && typeof value.schemaVersion === "number"
    ? value.schemaVersion
    : 0;
  if (
    !isRecord(value)
    || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(schemaVersion)
    || !Array.isArray(value.threads)
    || !value.threads.every((thread) => isThread(thread, schemaVersion))
    || !Array.isArray(value.deliveries)
    || !value.deliveries.every((delivery) =>
      isDelivery(delivery, schemaVersion >= 3, schemaVersion)
    )
    || !Array.isArray(value.resetReceipts)
    || !value.resetReceipts.every(isResetReceipt)
    || !Array.isArray(value.undoResetReceipts)
    || !value.undoResetReceipts.every(isUndoResetReceipt)
    || (
      schemaVersion >= 12
      && (
        !Array.isArray(value.experienceLearningPolicyAudits)
        || !value.experienceLearningPolicyAudits.every(isExperienceLearningPolicyAudit)
      )
    )
    || (
      schemaVersion >= 2
      && (
        !Array.isArray(value.interactionReceipts)
        || !value.interactionReceipts.every((receipt) =>
          isInteractionReceipt(receipt, schemaVersion >= 3)
        )
      )
    )
    || !isSafeVersion(value.nextPolicyVersion)
    || value.nextPolicyVersion < 1
  ) {
    invalid("attunement store is invalid; refusing to guess or overwrite it");
  }

  const state: AttunementState = {
    deliveries: (value.deliveries as unknown as readonly ContinuityDelivery[]).map(
      (delivery) => ({
        ...delivery,
        evidenceClass: delivery.evidenceClass ?? "unclassified",
        ...(delivery.outcome
          ? {
              outcome: {
                ...delivery.outcome,
                evidenceClass: delivery.outcome.evidenceClass ?? "unclassified"
              }
            }
          : {})
      })
    ),
    experienceLearningPolicyAudits: schemaVersion >= 12
      ? value.experienceLearningPolicyAudits as unknown as readonly ExperienceLearningPolicyAudit[]
      : [],
    interactionReceipts: schemaVersion >= 2
      ? (value.interactionReceipts as unknown as readonly ContinuityInteractionReceipt[])
          .map((receipt) => ({
            ...receipt,
            evidenceClass: receipt.evidenceClass ?? "unclassified"
          }))
      : [],
    nextPolicyVersion: value.nextPolicyVersion,
    resetReceipts: value.resetReceipts,
    schemaVersion: 12,
    threads: value.threads,
    undoResetReceipts: value.undoResetReceipts
  };
  validateStateRelations(state);
  return state;
}
