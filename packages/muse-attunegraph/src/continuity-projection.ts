import { createHash } from "node:crypto";

import type {
  ArtifactLink,
  ArtifactReference,
  AttunementState,
  ContinuityDelivery,
  ContinuityInteractionReceipt,
  ContinuityOutcomeRecord,
  ContinuityPolicy,
  ExperienceLearningPolicyAudit,
  PersonalThread,
  PolicyResetReceipt,
  UndoResetReceipt
} from "@muse/attunement";
import {
  AttunementStateValidationError,
  parseAttunementState
} from "@muse/attunement/state-validation";

import { MAX_GRAPH_APPEND_BATCH_ASSERTIONS } from "@attunegraph/core";
import type {
  GraphAssertion,
  GraphEvidenceRef,
  GraphPredicate,
  GraphRef
} from "@attunegraph/core";
import {
  canonicalAssertion,
  evidenceRefKey,
  normalizeGraphAssertion
} from "@attunegraph/core/extension-kit";
import {
  CONTINUITY_SOURCE_NAMESPACES,
  deriveContinuityArtifactGraphRef,
  deriveContinuityArtifactLinkSourceRef,
  deriveContinuityDeliveryGraphRef,
  deriveContinuityOutcomeGraphRef,
  deriveContinuityPolicyGraphRef,
  deriveContinuityPolicySourceRef,
  deriveContinuityThreadGraphRef
} from "./continuity-projection-identity.js";

export {
  EXPERIENCE_LEARNING_LINEAGE_PROJECTION_RULE_VERSION,
  ExperienceLearningLineageProjectionError,
  projectExperienceLearningLineage,
  type ExperienceLearningLineageProjection,
  type ExperienceLearningLineageProjectionErrorCode,
  type ExperienceLearningLineageProjectionInput,
  type ExperienceLearningLineageProjectionScope
} from "./experience-learning-lineage-projection.js";

export const CONTINUITY_PROJECTION_RULE_VERSION =
  "continuity-state-projection-v1" as const;

export { CONTINUITY_SOURCE_NAMESPACES };

export type ContinuityProjectionErrorCode =
  | "ASSERTION_COLLISION"
  | "INVALID_SOURCE"
  | "INVALID_STATE"
  | "PROJECTION_LIMIT"
  | "RULE_MISMATCH"
  | "SCOPE_MISMATCH"
  | "SCOPE_NOT_FOUND";

export class ContinuityProjectionError extends Error {
  readonly code: ContinuityProjectionErrorCode;

  constructor(code: ContinuityProjectionErrorCode, message: string) {
    super(message);
    this.name = "ContinuityProjectionError";
    this.code = code;
  }
}

export interface ContinuityProjectionScope {
  readonly sourceId: string;
  readonly threadId: string;
}

export interface ContinuityProjectionInput {
  readonly scope: ContinuityProjectionScope;
  readonly sourceObservedAt: string;
  readonly state: unknown;
}

export interface ContinuityProjectionTimestampBasis {
  readonly basis: "source-event" | "source-observation";
  readonly sourceRef: GraphEvidenceRef;
}

export interface ContinuityGraphProjection {
  readonly schemaVersion: 1;
  readonly ruleVersion: typeof CONTINUITY_PROJECTION_RULE_VERSION;
  readonly scope: ContinuityProjectionScope;
  readonly sourceVersion: string;
  readonly projectionVersion: string;
  readonly assertions: readonly GraphAssertion[];
  readonly timestampBasis: readonly ContinuityProjectionTimestampBasis[];
}

export interface ContinuityGraphProjectionDelta {
  readonly schemaVersion: 1;
  readonly ruleVersion: typeof CONTINUITY_PROJECTION_RULE_VERSION;
  readonly scope: ContinuityProjectionScope;
  readonly fromProjectionVersion: string;
  readonly toProjectionVersion: string;
  readonly append: readonly GraphAssertion[];
  readonly forgetAssertionIds: readonly string[];
  readonly unchangedAssertionIds: readonly string[];
}

type TimestampBasis = ContinuityProjectionTimestampBasis["basis"];

interface AssertionInput {
  readonly derivation?: GraphAssertion["derivation"];
  readonly epistemicClass: GraphAssertion["epistemicClass"];
  readonly object: GraphRef;
  readonly predicate: GraphPredicate;
  readonly recordedAt: string;
  readonly sourceRefs: readonly GraphEvidenceRef[];
  readonly subject: GraphRef;
  readonly validFrom?: string;
}

interface PolicyGeneration {
  readonly basis: TimestampBasis;
  readonly additionalSourceRef?: GraphEvidenceRef;
  readonly recordedAt: string;
  readonly validFrom?: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_SOURCE_ID_CHARACTERS = 128;

function invalidSource(message: string): never {
  throw new ContinuityProjectionError("INVALID_SOURCE", message);
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
    invalidSource(
      "projection sourceId must be a bounded logical identifier, never a path"
    );
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string") invalidSource(`${label} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    invalidSource(`${label} must be an ISO timestamp`);
  }
  return parsed.toISOString();
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
    if (!Number.isFinite(value)) invalidSource("canonical projection data must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidSource("canonical projection data must contain plain objects");
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  invalidSource("canonical projection data contains an unsupported value");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function opaqueId(kind: string, material: unknown): string {
  return `muse-continuity-${kind}:${digest(material).slice("sha256:".length)}`;
}

function sourceRef(
  namespace: string,
  sourceId: string,
  identity: unknown,
  versionView: unknown
): GraphEvidenceRef {
  return Object.freeze({
    id: opaqueId("source", { identity, namespace, sourceId }),
    namespace,
    version: digest(versionView)
  });
}

function graphRef(kind: GraphRef["kind"], material: unknown): GraphRef {
  return Object.freeze({ id: opaqueId(kind, material), kind });
}

export function continuityThreadGraphRef(
  scope: ContinuityProjectionScope
): GraphRef {
  const sourceId = safeSourceId(scope.sourceId);
  if (typeof scope.threadId !== "string" || scope.threadId.trim().length === 0) {
    invalidSource("projection threadId must be non-empty text");
  }
  return deriveContinuityThreadGraphRef(sourceId, scope.threadId);
}

function artifactIdentity(reference: ArtifactReference): object {
  return {
    artifactId: reference.artifactId,
    artifactType: reference.artifactType,
    providerId: reference.providerId
  };
}

function artifactReferenceView(reference: ArtifactReference): object {
  return {
    ...artifactIdentity(reference),
    role: reference.role
  };
}

function deliveryGraphRef(sourceId: string, deliveryId: string): GraphRef {
  return deriveContinuityDeliveryGraphRef(sourceId, deliveryId);
}

function deliveryEvidenceGraphRef(
  sourceId: string,
  deliveryId: string,
  reference: ArtifactReference
): GraphRef {
  return graphRef("evidence", {
    deliveryId,
    reference: artifactReferenceView(reference),
    sourceId
  });
}

function outcomeGraphRef(
  sourceId: string,
  deliveryId: string,
  outcome: ContinuityOutcomeRecord
): GraphRef {
  return deriveContinuityOutcomeGraphRef(sourceId, deliveryId, outcome);
}

function interactionGraphRef(
  sourceId: string,
  receiptId: string
): GraphRef {
  return graphRef("evidence", { receiptId, sourceId, type: "interaction" });
}

function policyView(policy: ContinuityPolicy): object {
  return {
    detail: policy.detail,
    nextStep: policy.nextStep,
    suppression: policy.suppression,
    version: policy.version
  };
}

function threadView(thread: PersonalThread): object {
  return {
    createdAt: canonicalInstant(thread.createdAt, "thread.createdAt"),
    id: thread.id,
    kind: thread.kind
  };
}

function linkView(link: ArtifactLink): object {
  return {
    ...artifactReferenceView(link),
    linkedAt: canonicalInstant(link.linkedAt, "link.linkedAt"),
    linkedBy: link.linkedBy,
    threadId: link.threadId
  };
}

function deliveryView(delivery: ContinuityDelivery): object {
  const evidenceRefs = [...delivery.evidenceRefs]
    .map(artifactReferenceView)
    .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return {
    evidenceClass: delivery.evidenceClass,
    evidenceRefs,
    id: delivery.id,
    ...(delivery.interactionAnchor
      ? {
          interactionAnchor: {
            artifactId: delivery.interactionAnchor.artifactId,
            linkedAt: canonicalInstant(
              delivery.interactionAnchor.linkedAt,
              "delivery.interactionAnchor.linkedAt"
            ),
            observedAt: canonicalInstant(
              delivery.interactionAnchor.observedAt,
              "delivery.interactionAnchor.observedAt"
            ),
            observedStatus: delivery.interactionAnchor.observedStatus,
            openStateFingerprint:
              delivery.interactionAnchor.openStateFingerprint,
            providerId: delivery.interactionAnchor.providerId,
            role: delivery.interactionAnchor.role
          }
        }
      : {}),
    openedAt: canonicalInstant(delivery.openedAt, "delivery.openedAt"),
    policyVersion: delivery.policyVersion,
    ...(delivery.runId ? { runId: delivery.runId } : {}),
    threadId: delivery.threadId
  };
}

function outcomeView(outcome: ContinuityOutcomeRecord): object {
  return {
    evidenceClass: outcome.evidenceClass,
    outcome: outcome.outcome,
    policyVersion: outcome.policyVersion,
    recordedAt: canonicalInstant(outcome.recordedAt, "outcome.recordedAt")
  };
}

function resetView(receipt: PolicyResetReceipt): object {
  return {
    basePolicyVersion: receipt.basePolicyVersion,
    beforePolicy: policyView(receipt.beforePolicy),
    id: receipt.id,
    resetPolicyVersion: receipt.resetPolicyVersion,
    threadId: receipt.threadId
  };
}

function undoView(receipt: UndoResetReceipt): object {
  return {
    id: receipt.id,
    previousPolicyVersion: receipt.previousPolicyVersion,
    resetId: receipt.resetId,
    restoredPolicy: policyView(receipt.restoredPolicy),
    threadId: receipt.threadId,
    undoneAt: canonicalInstant(receipt.undoneAt, "undo.undoneAt"),
    undoPolicyVersion: receipt.undoPolicyVersion
  };
}

function interactionView(receipt: ContinuityInteractionReceipt): object {
  return {
    artifactId: receipt.artifactId,
    completedAt: canonicalInstant(receipt.completedAt, "interaction.completedAt"),
    deliveryId: receipt.deliveryId,
    doneStateFingerprint: receipt.doneStateFingerprint,
    eventId: receipt.eventId,
    evidenceClass: receipt.evidenceClass,
    id: receipt.id,
    linkedAt: canonicalInstant(receipt.linkedAt, "interaction.linkedAt"),
    openStateFingerprint: receipt.openStateFingerprint,
    providerId: receipt.providerId,
    recordedAt: canonicalInstant(receipt.recordedAt, "interaction.recordedAt"),
    role: receipt.role,
    runId: receipt.runId,
    threadId: receipt.threadId,
    transition: receipt.transition
  };
}

function sortedSourceRefs(
  refs: readonly GraphEvidenceRef[]
): readonly GraphEvidenceRef[] {
  const result = [...refs].sort((left, right) =>
    evidenceRefKey(left).localeCompare(evidenceRefKey(right))
  );
  return Object.freeze(result);
}

function makeAssertion(input: AssertionInput): GraphAssertion {
  const sourceRefs = sortedSourceRefs(input.sourceRefs);
  const body = {
    schemaVersion: 1 as const,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    epistemicClass: input.epistemicClass,
    sourceRefs,
    ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    recordedAt: input.recordedAt,
    derivation: input.derivation ?? {
      kind: "projection" as const,
      version: CONTINUITY_PROJECTION_RULE_VERSION
    }
  };
  return normalizeGraphAssertion({
    ...body,
    id: opaqueId("assertion", body)
  });
}

function compareById<T extends { readonly id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function currentPolicyGeneration(
  sourceId: string,
  sourceObservedAt: string,
  thread: PersonalThread,
  deliveries: readonly ContinuityDelivery[],
  policyAudits: readonly ExperienceLearningPolicyAudit[],
  resets: readonly PolicyResetReceipt[],
  undos: readonly UndoResetReceipt[],
  threadSource: GraphEvidenceRef
): PolicyGeneration {
  const version = thread.policy.version;
  if (version === 0) {
    const recordedAt = canonicalInstant(thread.createdAt, "thread.createdAt");
    return {
      additionalSourceRef: threadSource,
      basis: "source-event",
      recordedAt,
      validFrom: recordedAt
    };
  }

  for (const delivery of deliveries) {
    if (delivery.outcome?.policyVersion !== version) continue;
    const recordedAt = canonicalInstant(
      delivery.outcome.recordedAt,
      "outcome.recordedAt"
    );
    return {
      additionalSourceRef: sourceRef(
        CONTINUITY_SOURCE_NAMESPACES.outcome,
        sourceId,
        { deliveryId: delivery.id },
        outcomeView(delivery.outcome)
      ),
      basis: "source-event",
      recordedAt,
      validFrom: recordedAt
    };
  }

  for (const undo of undos) {
    if (undo.undoPolicyVersion !== version) continue;
    const recordedAt = canonicalInstant(undo.undoneAt, "undo.undoneAt");
    return {
      additionalSourceRef: sourceRef(
        CONTINUITY_SOURCE_NAMESPACES.policyUndo,
        sourceId,
        { undoId: undo.id },
        undoView(undo)
      ),
      basis: "source-event",
      recordedAt,
      validFrom: recordedAt
    };
  }

  for (const reset of resets) {
    if (reset.resetPolicyVersion !== version) continue;
    return {
      additionalSourceRef: sourceRef(
        CONTINUITY_SOURCE_NAMESPACES.policyReset,
        sourceId,
        { resetId: reset.id },
        resetView(reset)
      ),
      basis: "source-observation",
      recordedAt: sourceObservedAt
    };
  }

  for (const audit of policyAudits) {
    if (
      audit.policyAfter.version !== version
      || canonicalJson(policyView(audit.policyAfter))
        !== canonicalJson(policyView(thread.policy))
    ) {
      continue;
    }
    const recordedAt = canonicalInstant(
      audit.occurredAt,
      "experienceLearningPolicyAudit.occurredAt"
    );
    return {
      basis: "source-event",
      recordedAt,
      validFrom: recordedAt
    };
  }

  throw new ContinuityProjectionError(
    "INVALID_STATE",
    `thread '${thread.id}' current policy has no generating source`
  );
}

function projectionSourceVersion(input: {
  readonly deliveries: readonly ContinuityDelivery[];
  readonly interactions: readonly ContinuityInteractionReceipt[];
  readonly links: readonly ArtifactLink[];
  readonly policyAudits: readonly ExperienceLearningPolicyAudit[];
  readonly resets: readonly PolicyResetReceipt[];
  readonly thread: PersonalThread;
  readonly undos: readonly UndoResetReceipt[];
}): string {
  return digest({
    deliveries: input.deliveries.map((delivery) => ({
      core: deliveryView(delivery),
      ...(delivery.outcome ? { outcome: outcomeView(delivery.outcome) } : {})
    })),
    interactions: input.interactions.map(interactionView),
    links: input.links.map(linkView),
    ...(input.policyAudits.length > 0
      ? {
          policyGenerations: input.policyAudits.map((audit) => ({
            kind: audit.kind,
            occurredAt: canonicalInstant(
              audit.occurredAt,
              "experienceLearningPolicyAudit.occurredAt"
            ),
            policyAfter: policyView(audit.policyAfter)
          }))
        }
      : {}),
    policy: policyView(input.thread.policy),
    resets: input.resets.map(resetView),
    thread: threadView(input.thread),
    undos: input.undos.map(undoView)
  });
}

export function projectContinuityState(
  input: ContinuityProjectionInput
): ContinuityGraphProjection {
  const sourceId = safeSourceId(input.scope?.sourceId);
  const sourceObservedAt = canonicalInstant(
    input.sourceObservedAt,
    "sourceObservedAt"
  );
  let state: AttunementState;
  try {
    state = parseAttunementState(input.state);
  } catch (cause) {
    if (cause instanceof AttunementStateValidationError) {
      throw new ContinuityProjectionError("INVALID_STATE", cause.message);
    }
    throw cause;
  }

  const thread = state.threads.find((candidate) =>
    candidate.id === input.scope?.threadId
  );
  if (!thread) {
    throw new ContinuityProjectionError(
      "SCOPE_NOT_FOUND",
      `projection thread '${String(input.scope?.threadId)}' does not exist`
    );
  }
  const scope = Object.freeze({ sourceId, threadId: thread.id });
  const threadRef = continuityThreadGraphRef(scope);
  const links = [...thread.links].sort((left, right) =>
    canonicalJson(artifactIdentity(left))
      .localeCompare(canonicalJson(artifactIdentity(right)))
  );
  const deliveries = state.deliveries
    .filter((delivery) => delivery.threadId === thread.id)
    .sort(compareById);
  const interactions = state.interactionReceipts
    .filter((receipt) => receipt.threadId === thread.id)
    .sort(compareById);
  const policyAudits = (state.experienceLearningPolicyAudits ?? [])
    .filter((audit) => audit.threadId === thread.id)
    .sort(compareById);
  const resets = state.resetReceipts
    .filter((receipt) => receipt.threadId === thread.id)
    .sort(compareById);
  const undos = state.undoResetReceipts
    .filter((receipt) => receipt.threadId === thread.id)
    .sort(compareById);

  const threadSource = sourceRef(
    CONTINUITY_SOURCE_NAMESPACES.thread,
    sourceId,
    { threadId: thread.id },
    threadView(thread)
  );
  const currentPolicySource = deriveContinuityPolicySourceRef(
    sourceId,
    thread.id,
    thread.policy
  );
  const assertions: GraphAssertion[] = [];
  const timestampBasis = new Map<string, ContinuityProjectionTimestampBasis>();
  const add = (
    assertion: GraphAssertion,
    basis: TimestampBasis = "source-event"
  ): void => {
    assertions.push(assertion);
    for (const ref of assertion.sourceRefs) {
      const key = evidenceRefKey(ref);
      const existing = timestampBasis.get(key);
      if (existing && existing.basis !== basis) {
        throw new ContinuityProjectionError(
          "INVALID_SOURCE",
          `source ${ref.namespace}/${ref.id} has conflicting timestamp bases`
        );
      }
      timestampBasis.set(key, Object.freeze({ basis, sourceRef: ref }));
    }
  };

  for (const link of links) {
    const linkedAt = canonicalInstant(link.linkedAt, "link.linkedAt");
    const linkSource = deriveContinuityArtifactLinkSourceRef(
      sourceId,
      thread.id,
      link,
      linkedAt
    );
    add(makeAssertion({
      epistemicClass: "user-asserted",
      object: threadRef,
      predicate: link.role === "next-step" ? "NEXT_STEP_FOR" : "CONTEXT_FOR",
      recordedAt: linkedAt,
      sourceRefs: [linkSource],
      subject: deriveContinuityArtifactGraphRef(sourceId, link),
      validFrom: linkedAt
    }));
  }

  for (const delivery of deliveries) {
    const openedAt = canonicalInstant(delivery.openedAt, "delivery.openedAt");
    const deliveryRef = deliveryGraphRef(sourceId, delivery.id);
    const deliverySource = sourceRef(
      CONTINUITY_SOURCE_NAMESPACES.delivery,
      sourceId,
      { deliveryId: delivery.id },
      deliveryView(delivery)
    );
    add(makeAssertion({
      epistemicClass: "source-observed",
      object: threadRef,
      predicate: "DELIVERED_FOR",
      recordedAt: openedAt,
      sourceRefs: [deliverySource],
      subject: deliveryRef,
      validFrom: openedAt
    }));
    add(makeAssertion({
      epistemicClass: "source-observed",
      object: deriveContinuityPolicyGraphRef(
        sourceId,
        thread.id,
        delivery.policyVersion
      ),
      predicate: "GOVERNED_BY",
      recordedAt: openedAt,
      sourceRefs: [deliverySource],
      subject: deliveryRef,
      validFrom: openedAt
    }));

    const evidenceRefs = [...delivery.evidenceRefs].sort((left, right) =>
      canonicalJson(artifactReferenceView(left))
        .localeCompare(canonicalJson(artifactReferenceView(right)))
    );
    for (const evidence of evidenceRefs) {
      const evidenceSource = sourceRef(
        CONTINUITY_SOURCE_NAMESPACES.deliveryEvidence,
        sourceId,
        {
          deliveryId: delivery.id,
          reference: artifactIdentity(evidence)
        },
        artifactReferenceView(evidence)
      );
      add(makeAssertion({
        epistemicClass: "source-observed",
        object: deliveryEvidenceGraphRef(sourceId, delivery.id, evidence),
        predicate: "SUPPORTED_BY",
        recordedAt: openedAt,
        sourceRefs: [deliverySource, evidenceSource],
        subject: deliveryRef,
        validFrom: openedAt
      }));
    }

    if (delivery.outcome) {
      const outcomeAt = canonicalInstant(
        delivery.outcome.recordedAt,
        "outcome.recordedAt"
      );
      const outcomeSource = sourceRef(
        CONTINUITY_SOURCE_NAMESPACES.outcome,
        sourceId,
        { deliveryId: delivery.id },
        outcomeView(delivery.outcome)
      );
      add(makeAssertion({
        epistemicClass: "source-observed",
        object: outcomeGraphRef(sourceId, delivery.id, delivery.outcome),
        predicate: "PRODUCED_OUTCOME",
        recordedAt: outcomeAt,
        sourceRefs: [outcomeSource],
        subject: deliveryRef,
        validFrom: outcomeAt
      }));
      add(makeAssertion({
        epistemicClass: "source-observed",
        object: deriveContinuityPolicyGraphRef(
          sourceId,
          thread.id,
          delivery.policyVersion
        ),
        predicate: "SUPERSEDES",
        recordedAt: outcomeAt,
        sourceRefs: [outcomeSource],
        subject: deriveContinuityPolicyGraphRef(
          sourceId,
          thread.id,
          delivery.outcome.policyVersion
        ),
        validFrom: outcomeAt
      }));
    }
  }

  for (const reset of resets) {
    const resetSource = sourceRef(
      CONTINUITY_SOURCE_NAMESPACES.policyReset,
      sourceId,
      { resetId: reset.id },
      resetView(reset)
    );
    add(makeAssertion({
      epistemicClass: "source-observed",
      object: deriveContinuityPolicyGraphRef(
        sourceId,
        thread.id,
        reset.basePolicyVersion
      ),
      predicate: "SUPERSEDES",
      recordedAt: sourceObservedAt,
      sourceRefs: [resetSource],
      subject: deriveContinuityPolicyGraphRef(
        sourceId,
        thread.id,
        reset.resetPolicyVersion
      )
    }), "source-observation");
  }

  for (const undo of undos) {
    const undoneAt = canonicalInstant(undo.undoneAt, "undo.undoneAt");
    const undoSource = sourceRef(
      CONTINUITY_SOURCE_NAMESPACES.policyUndo,
      sourceId,
      { undoId: undo.id },
      undoView(undo)
    );
    add(makeAssertion({
      epistemicClass: "source-observed",
      object: deriveContinuityPolicyGraphRef(
        sourceId,
        thread.id,
        undo.previousPolicyVersion
      ),
      predicate: "SUPERSEDES",
      recordedAt: undoneAt,
      sourceRefs: [undoSource],
      subject: deriveContinuityPolicyGraphRef(
        sourceId,
        thread.id,
        undo.undoPolicyVersion
      ),
      validFrom: undoneAt
    }));
  }

  const generation = currentPolicyGeneration(
    sourceId,
    sourceObservedAt,
    thread,
    deliveries,
    policyAudits,
    resets,
    undos,
    threadSource
  );
  add(makeAssertion({
    epistemicClass: "source-observed",
    object: threadRef,
    predicate: "SCOPED_TO",
    recordedAt: generation.recordedAt,
    sourceRefs: [
      currentPolicySource,
      ...(generation.additionalSourceRef
        ? [generation.additionalSourceRef]
        : [])
    ],
    subject: deriveContinuityPolicyGraphRef(
      sourceId,
      thread.id,
      thread.policy.version
    ),
    ...(generation.validFrom ? { validFrom: generation.validFrom } : {})
  }), generation.basis);

  const deliveryById = new Map(
    deliveries.map((delivery) => [delivery.id, delivery])
  );
  for (const receipt of interactions) {
    const delivery = deliveryById.get(receipt.deliveryId);
    if (!delivery) {
      throw new ContinuityProjectionError(
        "INVALID_STATE",
        `interaction '${receipt.id}' is outside its projection thread`
      );
    }
    const completedAt = canonicalInstant(
      receipt.completedAt,
      "interaction.completedAt"
    );
    const recordedAt = canonicalInstant(
      receipt.recordedAt,
      "interaction.recordedAt"
    );
    const interactionSource = sourceRef(
      CONTINUITY_SOURCE_NAMESPACES.interaction,
      sourceId,
      { receiptId: receipt.id },
      interactionView(receipt)
    );
    const interactionRef = interactionGraphRef(sourceId, receipt.id);
    add(makeAssertion({
      epistemicClass: "source-observed",
      object: threadRef,
      predicate: "OBSERVED_DURING",
      recordedAt,
      sourceRefs: [interactionSource],
      subject: interactionRef,
      validFrom: completedAt
    }));
    add(makeAssertion({
      epistemicClass: "source-observed",
      object: deliveryGraphRef(sourceId, delivery.id),
      predicate: "CORRELATES_WITH",
      recordedAt,
      sourceRefs: [interactionSource],
      subject: interactionRef,
      validFrom: completedAt
    }));
  }

  assertions.sort(compareById);
  if (assertions.length > MAX_GRAPH_APPEND_BATCH_ASSERTIONS) {
    throw new ContinuityProjectionError(
      "PROJECTION_LIMIT",
      `thread projection exceeds ${MAX_GRAPH_APPEND_BATCH_ASSERTIONS.toString()} assertions`
    );
  }
  const frozenAssertions = Object.freeze(assertions);
  const basis = Object.freeze(
    [...timestampBasis.values()].sort((left, right) =>
      evidenceRefKey(left.sourceRef).localeCompare(evidenceRefKey(right.sourceRef))
    )
  );
  const sourceVersion = projectionSourceVersion({
    deliveries,
    interactions,
    links,
    policyAudits,
    resets,
    thread,
    undos
  });
  const projectionVersion = digest({
    assertions: frozenAssertions,
    ruleVersion: CONTINUITY_PROJECTION_RULE_VERSION,
    scope
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    ruleVersion: CONTINUITY_PROJECTION_RULE_VERSION,
    scope,
    sourceVersion,
    projectionVersion,
    assertions: frozenAssertions,
    timestampBasis: basis
  });
}

function sameScope(
  left: ContinuityProjectionScope,
  right: ContinuityProjectionScope
): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

function assertionsById(
  projection: ContinuityGraphProjection,
  label: string
): ReadonlyMap<string, GraphAssertion> {
  const assertions = new Map<string, GraphAssertion>();
  for (const assertion of projection.assertions) {
    if (assertions.has(assertion.id)) {
      throw new ContinuityProjectionError(
        "ASSERTION_COLLISION",
        `${label} projection repeats assertion id '${assertion.id}'`
      );
    }
    assertions.set(assertion.id, assertion);
  }
  return assertions;
}

export function diffContinuityProjections(
  previous: ContinuityGraphProjection,
  next: ContinuityGraphProjection
): ContinuityGraphProjectionDelta {
  if (previous.schemaVersion !== 1 || next.schemaVersion !== 1) {
    throw new ContinuityProjectionError(
      "RULE_MISMATCH",
      "projection schema versions must both be 1"
    );
  }
  if (
    previous.ruleVersion !== CONTINUITY_PROJECTION_RULE_VERSION
    || next.ruleVersion !== CONTINUITY_PROJECTION_RULE_VERSION
  ) {
    throw new ContinuityProjectionError(
      "RULE_MISMATCH",
      "projection rule versions do not match the active projector"
    );
  }
  if (!sameScope(previous.scope, next.scope)) {
    throw new ContinuityProjectionError(
      "SCOPE_MISMATCH",
      "cannot diff Continuity projections from different source/thread scopes"
    );
  }

  const previousById = assertionsById(previous, "previous");
  const nextById = assertionsById(next, "next");
  const append: GraphAssertion[] = [];
  const unchangedAssertionIds: string[] = [];
  for (const assertion of next.assertions) {
    const existing = previousById.get(assertion.id);
    if (!existing) {
      append.push(assertion);
      continue;
    }
    if (canonicalAssertion(existing) !== canonicalAssertion(assertion)) {
      throw new ContinuityProjectionError(
        "ASSERTION_COLLISION",
        `assertion '${assertion.id}' changed without changing its content address`
      );
    }
    unchangedAssertionIds.push(assertion.id);
  }
  const forgetAssertionIds = previous.assertions
    .filter((assertion) => !nextById.has(assertion.id))
    .map((assertion) => assertion.id)
    .sort();
  append.sort(compareById);
  unchangedAssertionIds.sort();

  return Object.freeze({
    schemaVersion: 1 as const,
    ruleVersion: CONTINUITY_PROJECTION_RULE_VERSION,
    scope: Object.freeze({ ...previous.scope }),
    fromProjectionVersion: previous.projectionVersion,
    toProjectionVersion: next.projectionVersion,
    append: Object.freeze(append),
    forgetAssertionIds: Object.freeze(forgetAssertionIds),
    unchangedAssertionIds: Object.freeze(unchangedAssertionIds)
  });
}
