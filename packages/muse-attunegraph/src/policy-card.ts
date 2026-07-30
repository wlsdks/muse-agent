import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type {
  GraphAssertion,
  GraphEvidenceRef,
  GraphRef
} from "@attunegraph/core";
import {
  buildExperienceLearningProposalPreview,
  buildExperienceLearningReplayBundle,
  buildExperienceLearningReviewQueue,
  fingerprintContinuityPolicy,
  proposeExperienceLearningFromDelivery,
  type ExperienceLearningChange,
  type ExperienceLearningProposalDraft,
  type ExperienceLearningReplay
} from "@muse/attunement";
import {
  verifyMintedLocalAttunementSnapshotHeadRevalidation
} from "@muse/attunement/continuity-snapshots";
import { parseAttunementState } from "@muse/attunement/state-validation";
import { assertPlainDataTree, isRecord } from "@muse/shared";

import {
  captureContinuityObservation,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  deriveContinuityDeliveryGraphRef,
  deriveContinuityOutcomeGraphRef,
  deriveContinuityPolicyGraphRef,
  deriveContinuityThreadGraphRef
} from "./continuity-projection-identity.js";
import {
  settleAttuneGraphPolicyCardBudget
} from "./policy-card-finalization.js";

const POLICY_CARD_VERSION = "attunegraph-policy-card.v1" as const;
const OPPORTUNITY_ID = /^learning_opportunity_[a-f0-9]{64}$/u;
const MAX_INPUT_BYTES = 256 * 1024;

export type AttuneGraphPolicyCardLocaleV1 = "en" | "ko";

export type AttuneGraphPolicyCardHeldReasonV1 =
  | "invalid-input"
  | "untrusted-revalidation"
  | "provider-not-fresh"
  | "scope-mismatch"
  | "opportunity-not-found"
  | "proposal-held"
  | "replay-invalid"
  | "graph-invalid"
  | "graph-proof-missing"
  | "graph-proof-ambiguous"
  | "temporal-mismatch"
  | "budget-exceeded"
  | "internal-error";

export interface AttuneGraphPolicyCardCompileInputV1 {
  readonly schemaVersion: 1;
  readonly headRevalidation: unknown;
  readonly opportunityId: string;
  readonly draft: unknown;
  readonly evidenceCases: unknown;
  readonly locale: AttuneGraphPolicyCardLocaleV1;
}

export interface AttuneGraphPolicyCardControlV1 {
  readonly approvalGranted: false;
  readonly availability:
    | "external_to_preview"
    | "unavailable_in_preview";
  readonly effectPerformed: false;
  readonly externalSurface?: string;
  readonly kind: "apply" | "edit" | "reject" | "rollback" | "trial";
  readonly label: string;
  readonly note: string;
}

export interface AttuneGraphPolicyCardV1 {
  readonly schemaVersion: 1;
  readonly cardVersion: typeof POLICY_CARD_VERSION;
  readonly cardId: string;
  readonly renderId: string;
  readonly locale: AttuneGraphPolicyCardLocaleV1;
  readonly status: "review-preview";
  readonly title: string;
  readonly scope: Readonly<{
    readonly kind: "thread-only";
    readonly sourceId: string;
    readonly threadId: string;
  }>;
  readonly assessedSnapshot: Readonly<{
    readonly assessedAt: string;
    readonly currentWorldFreshness: false;
    readonly freshness:
      "provider-head-matched-at-assessment";
    readonly headProviderReceiptId: string;
    readonly providerAttestedDerivedGraph: false;
    readonly revalidationReceiptId: string;
    readonly stateDigest: string;
    readonly subjectProviderReceiptId: string;
  }>;
  readonly proposal: Readonly<{
    readonly activeBehaviorDigestAfter: string;
    readonly activeBehaviorDigestBefore: string;
    readonly candidateId: string;
    readonly expectedBenefit: string;
    readonly expiresAt: string;
    readonly previewId: string;
    readonly proposedAt: string;
    readonly proposedBehavior: string;
    readonly proposedChange: ExperienceLearningChange;
  }>;
  readonly evidence: Readonly<{
    readonly authoritativeExperience: Readonly<{
      readonly authority: "owner-explicit";
      readonly deliveryId: string;
      readonly evidenceClass: "controlled" | "organic-production";
      readonly label: string;
      readonly outcome: "adjusted" | "ignored" | "rejected";
      readonly outcomeId: string;
      readonly recordedAt: string;
      readonly sourceRunId: string;
    }>;
    readonly callerSuppliedReplayClaims: Readonly<{
      readonly aggregate: ExperienceLearningReplay["aggregate"];
      readonly executionProvenanceVerified: false;
      readonly label: string;
      readonly recommendation: ExperienceLearningReplay["recommendation"];
      readonly replayBundleId: string;
      readonly replayInputHash: string;
      readonly receiptHashes: readonly Readonly<{
        readonly baseline: string;
        readonly caseId: string;
        readonly challenger: string;
      }>[];
      readonly validation:
        "structurally-validated-self-consistent-caller-claims";
    }>;
    readonly graphExplanation: Readonly<{
      readonly assertionIds: readonly string[];
      readonly label: string;
      readonly observationReceiptId: string;
      readonly projectionVersion: string;
      readonly provenance:
        "locally-derived-from-provider-head-matched-assessed-snapshot";
      readonly providerAttested: false;
      readonly sourceVersion: string;
    }>;
  }>;
  readonly controls: readonly AttuneGraphPolicyCardControlV1[];
  readonly boundary: Readonly<{
    readonly activation: "none";
    readonly approval: "none";
    readonly effect: "none";
  }>;
  readonly labels: Readonly<{
    readonly assessedSnapshot: string;
    readonly authoritativeExperience: string;
    readonly callerSuppliedReplayClaims: string;
    readonly graphExplanation: string;
    readonly proposedChange: string;
  }>;
}

export type AttuneGraphPolicyCardCompileResultV1 =
  | Readonly<{
      readonly status: "rendered";
      readonly card: AttuneGraphPolicyCardV1;
    }>
  | Readonly<{
      readonly status: "held";
      readonly reason: AttuneGraphPolicyCardHeldReasonV1;
    }>;

interface ParsedEnvelope {
  readonly draft: ExperienceLearningProposalDraft;
  readonly evidenceCases: unknown;
  readonly headRevalidation: unknown;
  readonly locale: AttuneGraphPolicyCardLocaleV1;
  readonly opportunityId: string;
}

interface PolicyCardLabels {
  readonly title: string;
  readonly assessedSnapshot: string;
  readonly authoritativeExperience: string;
  readonly controlledExperience: string;
  readonly organicExperience: string;
  readonly callerSuppliedReplayClaims: string;
  readonly graphExplanation: string;
  readonly proposedChange: string;
  readonly controls: Readonly<Record<AttuneGraphPolicyCardControlV1["kind"], string>>;
  readonly controlNotes: Readonly<Record<AttuneGraphPolicyCardControlV1["kind"], string>>;
}

const LABELS: Readonly<Record<AttuneGraphPolicyCardLocaleV1, PolicyCardLabels>> =
  Object.freeze({
    en: Object.freeze({
      title: "What Muse learned — review preview",
      assessedSnapshot: "Provider head matched at assessment; not current-world proof",
      authoritativeExperience: "Authoritative experience",
      controlledExperience: "Controlled test outcome",
      organicExperience: "Owner-use outcome",
      callerSuppliedReplayClaims:
        "Caller-supplied replay claims — execution provenance not verified",
      graphExplanation:
        "AttuneGraph explanation locally derived from the assessed snapshot",
      proposedChange: "Proposed collaboration-policy change",
      controls: Object.freeze({
        apply: "Apply in separate approval flow",
        edit: "Edit unavailable",
        reject: "Reject unavailable",
        rollback: "Rollback unavailable before application",
        trial: "Trusted trial unavailable"
      }),
      controlNotes: Object.freeze({
        apply:
          "A separate stale-safe tool must revalidate the exact draft and obtain owner approval.",
        edit: "No edit or resubmission surface is available in this preview.",
        reject: "This preview does not record rejection or change policy.",
        rollback: "Rollback requires a separately applied promotion.",
        trial:
          "Replay receipts are self-consistent caller claims, not process-attested executions."
      })
    }),
    ko: Object.freeze({
      title: "Muse가 배운 점 — 검토 미리보기",
      assessedSnapshot: "평가 시점에 provider head가 일치했으며 현재 세계의 증명은 아님",
      authoritativeExperience: "권위 있는 경험 근거",
      controlledExperience: "통제 테스트 결과",
      organicExperience: "실사용자 사용 결과",
      callerSuppliedReplayClaims:
        "호출자 제공 replay 주장 — 실행 출처는 검증되지 않음",
      graphExplanation:
        "평가 스냅샷에서 로컬로 파생한 AttuneGraph 관계 설명",
      proposedChange: "제안된 협업 정책 변경",
      controls: Object.freeze({
        apply: "별도 승인 흐름에서 적용",
        edit: "수정 사용 불가",
        reject: "거절 사용 불가",
        rollback: "적용 전 되돌리기 사용 불가",
        trial: "신뢰된 시험 사용 불가"
      }),
      controlNotes: Object.freeze({
        apply:
          "별도의 stale-safe 도구가 같은 초안을 다시 검증하고 사용자 승인을 받아야 합니다.",
        edit: "이 미리보기에는 수정 또는 재제출 표면이 없습니다.",
        reject: "이 미리보기는 거절을 기록하거나 정책을 바꾸지 않습니다.",
        rollback: "되돌리기는 별도로 적용된 promotion이 있어야 가능합니다.",
        trial:
          "Replay receipt는 자기 일관적인 호출자 주장이며 프로세스가 증명한 실행이 아닙니다."
      })
    })
  });

function held(
  reason: AttuneGraphPolicyCardHeldReasonV1
): AttuneGraphPolicyCardCompileResultV1 {
  return Object.freeze({ reason, status: "held" as const });
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | undefined {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseEnvelope(input: unknown): ParsedEnvelope | undefined {
  const record = exactDataRecord(input, [
    "draft",
    "evidenceCases",
    "headRevalidation",
    "locale",
    "opportunityId",
    "schemaVersion"
  ]);
  if (!record || record.schemaVersion !== 1) return undefined;
  if (
    (record.locale !== "en" && record.locale !== "ko")
    || typeof record.opportunityId !== "string"
    || !OPPORTUNITY_ID.test(record.opportunityId)
  ) {
    return undefined;
  }
  try {
    assertPlainDataTree(record.draft, "attuneGraphPolicyCardDraft");
    assertPlainDataTree(
      record.evidenceCases,
      "attuneGraphPolicyCardEvidenceCases"
    );
  } catch {
    return undefined;
  }
  const draft = exactDataRecord(record.draft, [
    "expectedBenefit",
    "expiresAt",
    "experienceId",
    "proposedAt",
    "proposedBehavior",
    "proposedChange",
    "scope"
  ]);
  if (!draft) return undefined;
  const scope = exactDataRecord(draft.scope, ["kind", "threadId"]);
  if (
    !scope
    || typeof draft.expectedBenefit !== "string"
    || typeof draft.experienceId !== "string"
    || typeof draft.proposedAt !== "string"
    || typeof draft.proposedBehavior !== "string"
    || typeof draft.expiresAt !== "string"
  ) {
    return undefined;
  }
  return Object.freeze({
    draft: record.draft as unknown as ExperienceLearningProposalDraft,
    evidenceCases: record.evidenceCases,
    headRevalidation: record.headRevalidation,
    locale: record.locale,
    opportunityId: record.opportunityId
  });
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
    if (!Number.isFinite(value)) throw new TypeError("non-finite identity value");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  throw new TypeError("unsupported identity value");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function contentId(prefix: string, domain: string, value: unknown): string {
  return `${prefix}${createHash("sha256")
    .update(domain, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sameRef(left: GraphRef, right: GraphRef): boolean {
  return left.id === right.id && left.kind === right.kind;
}

function sameEvidenceRef(
  left: GraphEvidenceRef,
  right: GraphEvidenceRef
): boolean {
  return left.id === right.id
    && left.namespace === right.namespace
    && left.version === right.version;
}

function matchingAssertions(
  receipt: ContinuityObservationReceipt,
  predicate: GraphAssertion["predicate"],
  subject: GraphRef,
  object: GraphRef
): readonly GraphAssertion[] {
  return receipt.projection.assertions.filter((assertion) =>
    assertion.predicate === predicate
    && sameRef(assertion.subject, subject)
    && sameRef(assertion.object, object)
  );
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function temporalContractHolds(input: Readonly<{
  readonly deliveryOpenedAt: string;
  readonly expiresAt: string;
  readonly observedAt: string;
  readonly outcomeRecordedAt: string;
  readonly proposedAt: string;
  readonly sourceRunCompletedAt: string;
  readonly subjectCaptureCompletedAt: string;
  readonly deliveredFor: GraphAssertion;
  readonly governedBy: GraphAssertion;
  readonly producedOutcome: GraphAssertion;
  readonly scopedTo: GraphAssertion;
}>): boolean {
  const instants = [
    input.deliveryOpenedAt,
    input.expiresAt,
    input.observedAt,
    input.outcomeRecordedAt,
    input.proposedAt,
    input.sourceRunCompletedAt,
    input.subjectCaptureCompletedAt,
    input.deliveredFor.recordedAt,
    input.governedBy.recordedAt,
    input.producedOutcome.recordedAt,
    input.scopedTo.recordedAt,
    ...(input.scopedTo.validFrom ? [input.scopedTo.validFrom] : [])
  ];
  if (!instants.every(isCanonicalInstant)) return false;
  const opened = Date.parse(input.deliveryOpenedAt);
  const completed = Date.parse(input.sourceRunCompletedAt);
  const outcome = Date.parse(input.outcomeRecordedAt);
  const proposed = Date.parse(input.proposedAt);
  const expires = Date.parse(input.expiresAt);
  const observed = Date.parse(input.observedAt);
  return opened <= completed
    && completed <= outcome
    && outcome <= proposed
    && proposed < expires
    && observed >= outcome
    && input.observedAt === input.subjectCaptureCompletedAt
    && input.deliveredFor.recordedAt === input.deliveryOpenedAt
    && input.deliveredFor.validFrom === input.deliveryOpenedAt
    && input.governedBy.recordedAt === input.deliveryOpenedAt
    && input.governedBy.validFrom === input.deliveryOpenedAt
    && input.producedOutcome.recordedAt === input.outcomeRecordedAt
    && input.producedOutcome.validFrom === input.outcomeRecordedAt;
}

function scopedToBasisHolds(
  receipt: ContinuityObservationReceipt,
  scopedTo: GraphAssertion
): boolean {
  if (scopedTo.sourceRefs.length === 0) return false;
  const matches = scopedTo.sourceRefs.map((sourceRef) =>
    receipt.projection.timestampBasis.filter((entry) =>
      sameEvidenceRef(entry.sourceRef, sourceRef)
    )
  );
  if (matches.some((entries) => entries.length !== 1)) return false;
  const bases = new Set(matches.map((entries) => entries[0]!.basis));
  if (bases.size !== 1) return false;
  const basis = matches[0]![0]!.basis;
  if (basis === "source-observation") {
    return scopedTo.recordedAt === receipt.observedAt
      && scopedTo.validFrom === undefined;
  }
  return scopedTo.validFrom === scopedTo.recordedAt
    && Date.parse(scopedTo.recordedAt) <= Date.parse(receipt.observedAt);
}

function buildControls(
  labels: PolicyCardLabels
): readonly AttuneGraphPolicyCardControlV1[] {
  return Object.freeze([
    Object.freeze({
      approvalGranted: false as const,
      availability: "unavailable_in_preview" as const,
      effectPerformed: false as const,
      kind: "trial" as const,
      label: labels.controls.trial,
      note: labels.controlNotes.trial
    }),
    Object.freeze({
      approvalGranted: false as const,
      availability: "unavailable_in_preview" as const,
      effectPerformed: false as const,
      kind: "edit" as const,
      label: labels.controls.edit,
      note: labels.controlNotes.edit
    }),
    Object.freeze({
      approvalGranted: false as const,
      availability: "unavailable_in_preview" as const,
      effectPerformed: false as const,
      kind: "reject" as const,
      label: labels.controls.reject,
      note: labels.controlNotes.reject
    }),
    Object.freeze({
      approvalGranted: false as const,
      availability: "external_to_preview" as const,
      effectPerformed: false as const,
      externalSurface: "muse.continuity.learning.apply",
      kind: "apply" as const,
      label: labels.controls.apply,
      note: labels.controlNotes.apply
    }),
    Object.freeze({
      approvalGranted: false as const,
      availability: "unavailable_in_preview" as const,
      effectPerformed: false as const,
      externalSurface: "muse.continuity.learning.rollback",
      kind: "rollback" as const,
      label: labels.controls.rollback,
      note: labels.controlNotes.rollback
    })
  ]);
}

/**
 * Compile one inert Policy Card from one process-minted local snapshot.
 * Attunement remains authoritative; the graph and replay ledgers are
 * explanation and caller-claim evidence only.
 */
function compileAttuneGraphPolicyCardInternal(
  input: unknown
): AttuneGraphPolicyCardCompileResultV1 {
  const envelope = parseEnvelope(input);
  if (!envelope) return held("invalid-input");

  let inputBytes: number;
  try {
    inputBytes = utf8Bytes(canonicalJson({
      draft: envelope.draft,
      evidenceCases: envelope.evidenceCases,
      locale: envelope.locale,
      opportunityId: envelope.opportunityId,
      schemaVersion: 1
    }));
  } catch {
    return held("invalid-input");
  }
  if (inputBytes > MAX_INPUT_BYTES) return held("budget-exceeded");

  let verified;
  try {
    verified = verifyMintedLocalAttunementSnapshotHeadRevalidation(
      envelope.headRevalidation
    );
  } catch {
    return held("untrusted-revalidation");
  }
  if (
    verified.status !== "fresh"
    || verified.receipt.status !== "fresh"
    || verified.receipt.stage !== "revalidation"
    || verified.receipt.reason !== "head-state-matched-within-bound"
    || !verified.receipt.canAssertFreshAtAssessment
    || verified.subjectCapture.status !== "available"
    || verified.headCapture?.status !== "available"
  ) {
    return held("provider-not-fresh");
  }

  let state;
  try {
    state = parseAttunementState(
      JSON.parse(verified.subjectCapture.normalizedStateJson)
    );
  } catch {
    return held("scope-mismatch");
  }
  const providerScope = verified.receipt.providerScope;
  const scopedThreads = state.threads.filter((thread) =>
    thread.id === providerScope.threadId
  );
  if (
    scopedThreads.length !== 1
    || envelope.draft.scope.threadId !== providerScope.threadId
  ) {
    return held("scope-mismatch");
  }

  const queue = buildExperienceLearningReviewQueue(state);
  const opportunities = queue.items.filter((item) =>
    item.opportunityId === envelope.opportunityId
  );
  if (opportunities.length !== 1) return held("opportunity-not-found");
  const opportunity = opportunities[0]!;
  const deliveries = state.deliveries.filter((delivery) =>
    delivery.id === opportunity.deliveryId
  );
  if (deliveries.length !== 1) return held("opportunity-not-found");
  const delivery = deliveries[0]!;
  const thread = scopedThreads[0]!;
  if (
    opportunity.scope.threadId !== providerScope.threadId
    || delivery.threadId !== providerScope.threadId
  ) {
    return held("scope-mismatch");
  }

  const currentPolicyDigest = fingerprintContinuityPolicy(thread.policy);
  const proposal = proposeExperienceLearningFromDelivery({
    activeBehaviorDigest: currentPolicyDigest,
    delivery,
    draft: envelope.draft
  });
  if (proposal.status === "held") return held("proposal-held");
  const candidate = proposal.candidate;
  const preview = buildExperienceLearningProposalPreview(candidate);
  if (
    !preview
    || !delivery.outcome?.id
    || !delivery.policyDigest
    || !delivery.runId
    || candidate.outcome.outcomeId !== opportunity.outcome.outcomeId
    || candidate.outcome.outcomeId !== delivery.outcome.id
    || candidate.outcome.outcome !== opportunity.outcome.outcome
    || candidate.sourceRun.runId !== opportunity.sourceRun.runId
    || candidate.sourceRun.runId !== delivery.runId
    || candidate.sourceRun.behaviorDigest !== delivery.policyDigest
    || candidate.activeBehaviorDigestBefore !== currentPolicyDigest
  ) {
    return held("proposal-held");
  }

  const replayBundle = buildExperienceLearningReplayBundle(
    candidate,
    envelope.evidenceCases
  );
  if (!replayBundle) return held("replay-invalid");

  let observation: ContinuityObservationReceipt;
  try {
    observation = verifyContinuityObservation(captureContinuityObservation({
      scope: providerScope,
      sourceObservedAt:
        verified.subjectCapture.receipt.captureCompletedAt,
      state
    }));
  } catch {
    return held("graph-invalid");
  }
  if (
    observation.projection.scope.sourceId !== providerScope.sourceId
    || observation.projection.scope.threadId !== providerScope.threadId
  ) {
    return held("graph-invalid");
  }

  const threadRef = deriveContinuityThreadGraphRef(
    providerScope.sourceId,
    providerScope.threadId
  );
  const deliveryRef = deriveContinuityDeliveryGraphRef(
    providerScope.sourceId,
    delivery.id
  );
  const deliveryPolicyRef = deriveContinuityPolicyGraphRef(
    providerScope.sourceId,
    providerScope.threadId,
    delivery.policyVersion
  );
  const currentPolicyRef = deriveContinuityPolicyGraphRef(
    providerScope.sourceId,
    providerScope.threadId,
    thread.policy.version
  );
  const outcomeRef = deriveContinuityOutcomeGraphRef(
    providerScope.sourceId,
    delivery.id,
    delivery.outcome
  );
  const proofSets = [
    matchingAssertions(observation, "DELIVERED_FOR", deliveryRef, threadRef),
    matchingAssertions(
      observation,
      "GOVERNED_BY",
      deliveryRef,
      deliveryPolicyRef
    ),
    matchingAssertions(
      observation,
      "PRODUCED_OUTCOME",
      deliveryRef,
      outcomeRef
    ),
    matchingAssertions(observation, "SCOPED_TO", currentPolicyRef, threadRef)
  ] as const;
  if (proofSets.some((set) => set.length === 0)) {
    return held("graph-proof-missing");
  }
  if (proofSets.some((set) => set.length !== 1)) {
    return held("graph-proof-ambiguous");
  }
  const [
    deliveredFor,
    governedBy,
    producedOutcome,
    scopedTo
  ] = proofSets.map((set) => set[0]!) as [
    GraphAssertion,
    GraphAssertion,
    GraphAssertion,
    GraphAssertion
  ];
  if (
    !scopedToBasisHolds(observation, scopedTo)
    || !temporalContractHolds({
      deliveredFor,
      deliveryOpenedAt: delivery.openedAt,
      expiresAt: preview.expiresAt,
      governedBy,
      observedAt: observation.observedAt,
      outcomeRecordedAt: candidate.outcome.recordedAt,
      producedOutcome,
      proposedAt: preview.proposedAt,
      scopedTo,
      sourceRunCompletedAt: candidate.sourceRun.completedAt,
      subjectCaptureCompletedAt:
        verified.subjectCapture.receipt.captureCompletedAt
    })
  ) {
    return held("temporal-mismatch");
  }

  try {
    const labels = LABELS[envelope.locale];
    const controls = buildControls(labels);
    const assertionIds = Object.freeze(
      [deliveredFor.id, governedBy.id, producedOutcome.id, scopedTo.id].sort()
    );
    const receiptHashes = Object.freeze(replayBundle.cases.map((entry) =>
      Object.freeze({
        baseline: entry.baseline.evidenceHash,
        caseId: entry.caseId,
        challenger: entry.challenger.evidenceHash
      })
    ));
    const join = Object.freeze({
      candidateId: candidate.candidateId,
      currentPolicyDigest,
      currentPolicyVersion: thread.policy.version,
      deliveryId: delivery.id,
      deliveryPolicyDigest: delivery.policyDigest,
      deliveryPolicyVersion: delivery.policyVersion,
      opportunityId: opportunity.opportunityId,
      outcomeId: candidate.outcome.outcomeId,
      previewId: preview.previewId,
      providerRevalidationReceiptId: verified.receipt.receiptId,
      providerSubjectReceiptId: verified.receipt.subject.providerReceiptId,
      providerSubjectStateDigest: verified.receipt.subject.stateDigest,
      replayBundleId: replayBundle.bundleId,
      sourceId: providerScope.sourceId,
      sourceRunId: candidate.sourceRun.runId,
      threadId: providerScope.threadId
    });
    const semanticControls = controls.map((control) => ({
      approvalGranted: control.approvalGranted,
      availability: control.availability,
      effectPerformed: control.effectPerformed,
      ...(control.externalSurface
        ? { externalSurface: control.externalSurface }
        : {}),
      kind: control.kind
    }));
    const semanticCore = {
      assertionIds,
      cardVersion: POLICY_CARD_VERSION,
      evidenceClasses: {
        authoritativeExperience: candidate.sourceRun.evidenceClass,
        graph: "locally-derived-from-assessed-snapshot",
        replay: "caller-supplied-unverified-execution"
      },
      join,
      observation: {
        observationReceiptId: observation.receiptId,
        projectionVersion: observation.projection.projectionVersion,
        sourceVersion: observation.projection.sourceVersion
      },
      proposal: {
        activeBehaviorDigestAfter: preview.activeBehaviorDigestAfter,
        activeBehaviorDigestBefore: preview.activeBehaviorDigestBefore,
        expectedBenefit: preview.expectedBenefit,
        expiresAt: preview.expiresAt,
        proposedAt: preview.proposedAt,
        proposedBehavior: preview.proposedBehavior,
        proposedChange: preview.proposedChange
      },
      replay: {
        aggregate: replayBundle.replay.aggregate,
        inputHash: replayBundle.replay.inputHash,
        receiptHashes,
        recommendation: replayBundle.replay.recommendation
      },
      scope: {
        kind: "thread-only",
        sourceId: providerScope.sourceId,
        threadId: providerScope.threadId
      },
      semanticControls
    };
    const cardId = contentId(
      "attunegraph_policy_card_",
      `${POLICY_CARD_VERSION}:semantic:`,
      semanticCore
    );
    const renderLabels = Object.freeze({
      assessedSnapshot: labels.assessedSnapshot,
      authoritativeExperience: labels.authoritativeExperience,
      callerSuppliedReplayClaims: labels.callerSuppliedReplayClaims,
      graphExplanation: labels.graphExplanation,
      proposedChange: labels.proposedChange
    });
    const renderId = contentId(
      "attunegraph_policy_card_render_",
      `${POLICY_CARD_VERSION}:render:`,
      { cardId, controls, labels: renderLabels, locale: envelope.locale }
    );
    const card = deepFreeze({
      schemaVersion: 1 as const,
      cardVersion: POLICY_CARD_VERSION,
      cardId,
      renderId,
      locale: envelope.locale,
      status: "review-preview" as const,
      title: labels.title,
      scope: {
        kind: "thread-only" as const,
        sourceId: providerScope.sourceId,
        threadId: providerScope.threadId
      },
      assessedSnapshot: {
        assessedAt: verified.receipt.subject.captureCompletedAt,
        currentWorldFreshness: false as const,
        freshness: "provider-head-matched-at-assessment" as const,
        headProviderReceiptId: verified.receipt.head.providerReceiptId,
        providerAttestedDerivedGraph: false as const,
        revalidationReceiptId: verified.receipt.receiptId,
        stateDigest: verified.receipt.subject.stateDigest,
        subjectProviderReceiptId: verified.receipt.subject.providerReceiptId
      },
      proposal: {
        activeBehaviorDigestAfter: preview.activeBehaviorDigestAfter,
        activeBehaviorDigestBefore: preview.activeBehaviorDigestBefore,
        candidateId: preview.candidateId,
        expectedBenefit: preview.expectedBenefit,
        expiresAt: preview.expiresAt,
        previewId: preview.previewId,
        proposedAt: preview.proposedAt,
        proposedBehavior: preview.proposedBehavior,
        proposedChange: { ...preview.proposedChange }
      },
      evidence: {
        authoritativeExperience: {
          authority: "owner-explicit" as const,
          deliveryId: delivery.id,
          evidenceClass: candidate.sourceRun.evidenceClass,
          label: candidate.sourceRun.evidenceClass === "organic-production"
            ? labels.organicExperience
            : labels.controlledExperience,
          outcome: opportunity.outcome.outcome,
          outcomeId: candidate.outcome.outcomeId,
          recordedAt: candidate.outcome.recordedAt,
          sourceRunId: candidate.sourceRun.runId
        },
        callerSuppliedReplayClaims: {
          aggregate: { ...replayBundle.replay.aggregate },
          executionProvenanceVerified: false as const,
          label: labels.callerSuppliedReplayClaims,
          recommendation: replayBundle.replay.recommendation,
          replayBundleId: replayBundle.bundleId,
          replayInputHash: replayBundle.replay.inputHash,
          receiptHashes,
          validation:
            "structurally-validated-self-consistent-caller-claims" as const
        },
        graphExplanation: {
          assertionIds,
          label: labels.graphExplanation,
          observationReceiptId: observation.receiptId,
          projectionVersion: observation.projection.projectionVersion,
          provenance:
            "locally-derived-from-provider-head-matched-assessed-snapshot" as const,
          providerAttested: false as const,
          sourceVersion: observation.projection.sourceVersion
        }
      },
      controls,
      boundary: {
        activation: "none" as const,
        approval: "none" as const,
        effect: "none" as const
      },
      labels: renderLabels
    }) satisfies AttuneGraphPolicyCardV1;
    const settlement = settleAttuneGraphPolicyCardBudget(
      canonicalJson(card),
      () => Object.freeze({ card, status: "rendered" as const })
    );
    if (settlement.status === "budget-exceeded") {
      return held("budget-exceeded");
    }
    return settlement.value;
  } catch {
    return held("internal-error");
  }
}

/**
 * Total public boundary for Policy Card compilation.
 *
 * Domain failures retain the internal compiler's explicit held precedence.
 * Any unexpected implementation or dependency failure is reduced to one
 * non-sensitive finite reason rather than escaping the public union.
 */
export function compileAttuneGraphPolicyCard(
  input: unknown
): AttuneGraphPolicyCardCompileResultV1 {
  try {
    return compileAttuneGraphPolicyCardInternal(input);
  } catch {
    return held("internal-error");
  }
}
