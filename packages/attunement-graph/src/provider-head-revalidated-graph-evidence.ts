import {
  verifyMintedLocalAttunementSnapshotHeadRevalidation,
  type LocalAttunementSnapshotHeadRevalidationReceiptV1
} from "@muse/attunement/continuity-snapshots";

import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import {
  assertGraphSnapshotFreshnessScopePair,
  parseGraphDeclaredFreshness,
  parseGraphSnapshotProvenance,
  type GraphDeclaredFreshnessV1,
  type GraphSnapshotProvenanceV1
} from "./graph-snapshot-provenance.js";
import {
  PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET,
  projectAvailableProviderCaptureToGraphEvidence,
  type DerivedProviderGraphNominations
} from "./provider-bound-graph-evidence.js";
import type { ContinuityObservationReceipt } from "./continuity-observation.js";
import { continuityThreadGraphRef } from "./continuity-projection.js";
import type { ReceiptBoundGraphEvidenceV1 } from "./receipt-bound-graph-evidence.js";
import type { GraphRef } from "./types.js";

const RECEIPT_SPEC = Object.freeze({
  hashDomain:
    "muse.attunement-graph.provider-head-revalidated-graph-evidence-receipt.v1",
  idField: "receiptId",
  idPrefix: "muse-provider-head-revalidated-graph-evidence:sha256:"
} as const);
const RECEIPT_ID =
  /^muse-provider-head-revalidated-graph-evidence:sha256:[0-9a-f]{64}$/u;
const REVALIDATION_RECEIPT_ID =
  /^muse-local-attunement-head-revalidation:sha256:[0-9a-f]{64}$/u;
const OBSERVATION_RECEIPT_ID =
  /^muse-continuity-observation:v1:sha256:[0-9a-f]{64}$/u;
const GRAPH_EVIDENCE_RECEIPT_ID =
  /^muse-receipt-bound-graph-evidence-receipt:sha256:[0-9a-f]{64}$/u;
const GRAPH_ACTIVATION_EVIDENCE_ID =
  /^muse-receipt-bound-activation-evidence:sha256:[0-9a-f]{64}$/u;
const THREAD_SEED_ID = /^muse-continuity-thread:[0-9a-f]{64}$/u;
const OMITTED_DIGEST =
  /^muse-provider-bound-omitted-assertion-ids:sha256:[0-9a-f]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_RETAINED_PROVIDER_OPTIONALS = 255;

type HeadSnapshot = Extract<
  GraphSnapshotProvenanceV1,
  { readonly kind: "process-local-provider-head-revalidation" }
>;
type HeadFreshness = Extract<
  GraphDeclaredFreshnessV1,
  { readonly basis: "provider-head-revalidation" }
>;
type FreshRevalidationReceipt = Extract<
  LocalAttunementSnapshotHeadRevalidationReceiptV1,
  { readonly captureSpanMs: number }
> & Readonly<{
  readonly status: "fresh";
  readonly reason: "head-state-matched-within-bound";
}>;

type FreshCoverageReason =
  | "single-local-store"
  | "two-endpoint-provider-revalidation"
  | "fresh-at-assessment-only"
  | "source-authority-unverified"
  | "nomination-capacity-bounded"
  | "graph-settlement-partial";

export type ProviderHeadRevalidatedGraphBindingReceiptV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly receiptVersion:
    "muse.provider-head-revalidated-graph-evidence-receipt.v1";
  readonly receiptId: string;
  readonly authority: "receipt-integrity-only";
  readonly status: "partial" | "stale" | "abstained";
  readonly stage: "provider" | "revalidation" | "graph-evidence";
  readonly revalidationReceiptId: string;
  readonly providerId: "muse.local-attunement-store";
  readonly providerVersion: "muse.local-attunement-snapshot-provider.v1";
  readonly providerScope: Readonly<{
    readonly sourceId: string;
    readonly threadId: string;
  }>;
  readonly providerFreshness: Readonly<{
    readonly status: "fresh-at-assessment" | "not-fresh";
    readonly reason:
      | "head-state-matched-within-bound"
      | "head-state-changed"
      | "capture-span-exceeded"
      | "requested-scope-unavailable"
      | "source-read-failed"
      | "source-capacity-exceeded";
  }>;
  readonly canAssertFreshAtAssessment: boolean;
  readonly canAssertAbsenceWithinSnapshot: false;
  readonly canAssertCurrentWorldAbsence: false;
  readonly canAssertDurableProviderAuthority: false;
  readonly mintVerification:
    | "provider-owned-revalidation-artifact-verified-in-composing-process"
    | "provider-owned-two-capture-pair-verified-in-composing-process";
  readonly mintVerificationSurvivesSerialization: false;
  readonly coverage: Readonly<{
    readonly status: "partial" | "stale" | "abstained";
    readonly reasons: readonly FreshCoverageReason[] | readonly [
      "provider-head-revalidation-not-admitted-to-graph"
    ];
  }>;
  readonly graphObservationReceiptId?: string;
  readonly graphEvidenceReceiptId?: string;
  readonly graphActivationEvidenceId?: string;
  readonly graphActualSeed?: GraphRef;
  readonly nominations?: DerivedProviderGraphNominations["counts"];
  readonly budget?: typeof PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET;
  readonly snapshot?: HeadSnapshot;
  readonly declaredFreshness?: HeadFreshness;
}>;

export type ProviderHeadRevalidatedGraphEvidenceV1 =
  | Readonly<{
      readonly status: "stale" | "abstained";
      readonly stage: "provider" | "revalidation";
      readonly revalidationReceipt:
        LocalAttunementSnapshotHeadRevalidationReceiptV1;
      readonly receipt: ProviderHeadRevalidatedGraphBindingReceiptV1;
    }>
  | Readonly<{
      readonly status: "partial";
      readonly stage: "graph-evidence";
      readonly revalidationReceipt:
        LocalAttunementSnapshotHeadRevalidationReceiptV1;
      readonly graphObservationReceipt: ContinuityObservationReceipt;
      readonly graphEvidence: ReceiptBoundGraphEvidenceV1;
      readonly receipt: ProviderHeadRevalidatedGraphBindingReceiptV1;
    }>;

export type ProviderHeadRevalidatedGraphEvidenceErrorCode =
  | "INVALID_REVALIDATION"
  | "GRAPH_EVIDENCE_FAILED"
  | "INVALID_RECEIPT"
  | "INTEGRITY_MISMATCH"
  | "INTERNAL_POSTCONDITION_FAILED";

export class ProviderHeadRevalidatedGraphEvidenceError extends Error {
  readonly code: ProviderHeadRevalidatedGraphEvidenceErrorCode;
  readonly details: Readonly<{ readonly path: string; readonly reason: string }>;

  constructor(
    code: ProviderHeadRevalidatedGraphEvidenceErrorCode,
    reason: string,
    path: string
  ) {
    super("provider-head-revalidated-graph-evidence-failed");
    this.name = "ProviderHeadRevalidatedGraphEvidenceError";
    this.code = code;
    this.details = Object.freeze({ path: path.slice(0, 512), reason });
    delete (this as { stack?: unknown }).stack;
    for (const key of ["message", "name", "code", "details"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: key === "code" || key === "details",
        value: this[key],
        writable: false
      });
    }
    Object.freeze(this);
  }
}

function fail(
  code: ProviderHeadRevalidatedGraphEvidenceErrorCode,
  reason: string,
  path: string
): never {
  throw new ProviderHeadRevalidatedGraphEvidenceError(code, reason, path);
}

function freezeRecord<T extends Record<string, unknown>>(
  value: T
): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor && key !== "length") {
        freezeTree(descriptor.value);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function sealReceipt(
  body: Record<string, unknown>
): ProviderHeadRevalidatedGraphBindingReceiptV1 {
  try {
    const first = canonicalizeImmutableEnvelope(
      JSON.parse(JSON.stringify(body)),
      "external-mutable",
      RECEIPT_SPEC
    );
    const second = canonicalizeImmutableEnvelope(
      first.envelope,
      "muse-frozen",
      RECEIPT_SPEC
    );
    if (
      first.contentId !== second.contentId
      || first.canonicalJson !== second.canonicalJson
      || first.canonicalByteLength !== second.canonicalByteLength
      || !RECEIPT_ID.test(first.contentId)
    ) {
      fail(
        "INTERNAL_POSTCONDITION_FAILED",
        "receipt-postcondition-failed",
        "/receipt"
      );
    }
    return second.envelope as ProviderHeadRevalidatedGraphBindingReceiptV1;
  } catch (cause) {
    if (cause instanceof ProviderHeadRevalidatedGraphEvidenceError) {
      throw cause;
    }
    fail(
      "INTERNAL_POSTCONDITION_FAILED",
      "receipt-postcondition-failed",
      "/receipt"
    );
  }
}

function commonReceipt(
  receipt: LocalAttunementSnapshotHeadRevalidationReceiptV1
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    receiptVersion:
      "muse.provider-head-revalidated-graph-evidence-receipt.v1",
    authority: "receipt-integrity-only",
    revalidationReceiptId: receipt.receiptId,
    providerId: receipt.providerId,
    providerVersion: receipt.providerVersion,
    providerScope: receipt.providerScope,
    canAssertFreshAtAssessment: receipt.canAssertFreshAtAssessment,
    canAssertAbsenceWithinSnapshot: false,
    canAssertCurrentWorldAbsence: false,
    canAssertDurableProviderAuthority: false,
    mintVerification: receipt.mintVerification,
    mintVerificationSurvivesSerialization: false
  };
}

function snapshot(
  receipt: FreshRevalidationReceipt
): HeadSnapshot {
  return freezeRecord({
    authority: "receipt-integrity-only" as const,
    kind: "process-local-provider-head-revalidation" as const,
    revalidationReceiptId: receipt.receiptId,
    providerId: receipt.providerId,
    providerVersion: receipt.providerVersion,
    providerScope: receipt.providerScope,
    subject: receipt.subject,
    head: receipt.head,
    mintVerification: receipt.mintVerification,
    mintVerificationSurvivesSerialization: false as const
  }) as HeadSnapshot;
}

function freshness(
  receipt: FreshRevalidationReceipt
): HeadFreshness {
  return freezeRecord({
    basis: "provider-head-revalidation" as const,
    status: "fresh" as const,
    providerScope: receipt.providerScope,
    observedAt: receipt.subject.captureCompletedAt,
    assessedAt: receipt.head.captureCompletedAt,
    captureSpanMs: receipt.captureSpanMs,
    maxCaptureSpanMs: receipt.maxCaptureSpanMs,
    reasonId: "head-state-matched-within-bound" as const,
    revalidationReceiptId: receipt.receiptId
  }) as HeadFreshness;
}

export async function compileHeadRevalidatedProviderBoundGraphEvidence(
  artifact: unknown
): Promise<ProviderHeadRevalidatedGraphEvidenceV1> {
  let verified;
  try {
    verified =
      verifyMintedLocalAttunementSnapshotHeadRevalidation(artifact);
  } catch {
    fail(
      "INVALID_REVALIDATION",
      "revalidation-not-minted",
      "/revalidation"
    );
  }
  const revalidation = verified.receipt;
  if (revalidation.status !== "fresh") {
    const receipt = sealReceipt({
      ...commonReceipt(revalidation),
      status: revalidation.status,
      stage: revalidation.stage,
      providerFreshness: {
        status: "not-fresh",
        reason: revalidation.reason
      },
      coverage: {
        status: revalidation.status,
        reasons: ["provider-head-revalidation-not-admitted-to-graph"]
      }
    });
    return freezeTree(freezeRecord({
      status: revalidation.status,
      stage: revalidation.stage,
      revalidationReceipt: revalidation,
      receipt
    })) as ProviderHeadRevalidatedGraphEvidenceV1;
  }
  const freshReceipt = revalidation as FreshRevalidationReceipt;
  const graphSnapshot = snapshot(freshReceipt);
  const graphFreshness = freshness(freshReceipt);
  try {
    assertGraphSnapshotFreshnessScopePair(
      graphSnapshot,
      graphFreshness,
      revalidation.providerScope,
      {
        snapshot: "/snapshot",
        freshness: "/declaredFreshness",
        expectedScope: "/scope"
      }
    );
  } catch {
    fail(
      "INTERNAL_POSTCONDITION_FAILED",
      "snapshot-freshness-boundary-mismatch",
      "/snapshot"
    );
  }
  let projection;
  try {
    projection = await projectAvailableProviderCaptureToGraphEvidence({
      capture: verified.subjectCapture,
      snapshot: graphSnapshot,
      freshness: graphFreshness,
      expectedStatus: "partial"
    });
  } catch {
    fail("GRAPH_EVIDENCE_FAILED", "graph-evidence-failed", "/graphEvidence");
  }
  const reasons: FreshCoverageReason[] = [
    "single-local-store",
    "two-endpoint-provider-revalidation",
    "fresh-at-assessment-only",
    "source-authority-unverified"
  ];
  if (projection.nominations.counts.omitted > 0) {
    reasons.push("nomination-capacity-bounded");
  }
  reasons.push("graph-settlement-partial");
  const receipt = sealReceipt({
    ...commonReceipt(revalidation),
    status: "partial",
    stage: "graph-evidence",
    providerFreshness: {
      status: "fresh-at-assessment",
      reason: "head-state-matched-within-bound"
    },
    coverage: {
      status: "partial",
      reasons
    },
    graphObservationReceiptId: projection.observation.receiptId,
    graphEvidenceReceiptId: projection.graph.receipt.receiptId,
    graphActivationEvidenceId:
      projection.graph.activationEvidence.evidenceId,
    graphActualSeed: projection.graph.receipt.actualSeed,
    nominations: projection.nominations.counts,
    budget: PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET,
    snapshot: graphSnapshot,
    declaredFreshness: graphFreshness
  });
  return freezeTree(freezeRecord({
    status: "partial" as const,
    stage: "graph-evidence" as const,
    revalidationReceipt: revalidation,
    graphObservationReceipt: projection.observation,
    graphEvidence: projection.graph,
    receipt
  }));
}

function closedRecord(
  value: unknown,
  fields: readonly string[],
  path: string
): Readonly<Record<string, unknown>> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    fail("INVALID_RECEIPT", "invalid-field-set", path);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== "string")
    || fields.some((field) => !Object.hasOwn(value, field))
  ) {
    fail("INVALID_RECEIPT", "invalid-field-set", path);
  }
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail("INVALID_RECEIPT", "invalid-field-set", path);
    }
  }
  return value as Readonly<Record<string, unknown>>;
}

function closedReasons(
  value: unknown,
  expected: readonly string[],
  path: string
): void {
  if (
    !Array.isArray(value)
    || value.length !== expected.length
    || expected.some((reason, index) => value[index] !== reason)
    || Reflect.ownKeys(value).some((key) =>
      typeof key !== "string"
      || (
        key !== "length"
        && !/^(?:0|[1-9][0-9]*)$/u.test(key)
      )
    )
  ) {
    fail("INVALID_RECEIPT", "invalid-coverage", path);
  }
}

function closedScope(
  value: unknown,
  path: string
): Readonly<{ readonly sourceId: string; readonly threadId: string }> {
  const scope = closedRecord(value, ["sourceId", "threadId"], path);
  if (
    typeof scope.sourceId !== "string"
    || !SOURCE_ID.test(scope.sourceId)
    || typeof scope.threadId !== "string"
    || scope.threadId.length === 0
    || scope.threadId !== scope.threadId.trim()
    || Array.from(scope.threadId).length > 256
    || /[\u0000-\u001f\u007f]/u.test(scope.threadId)
  ) {
    fail("INVALID_RECEIPT", "invalid-provider-scope", path);
  }
  return scope as Readonly<{
    readonly sourceId: string;
    readonly threadId: string;
  }>;
}

function sameProviderScope(
  left: Readonly<{ readonly sourceId: string; readonly threadId: string }>,
  right: Readonly<{ readonly sourceId: string; readonly threadId: string }>
): boolean {
  return left.sourceId === right.sourceId
    && left.threadId === right.threadId;
}

function closedSafeInteger(
  value: unknown,
  minimum: number,
  path: string
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
  ) {
    fail("INVALID_RECEIPT", "invalid-safe-integer", path);
  }
  return value;
}

function verifyClosedGraphFields(
  root: Readonly<Record<string, unknown>>,
  providerScope: Readonly<{
    readonly sourceId: string;
    readonly threadId: string;
  }>
): void {
  if (
    typeof root.graphObservationReceiptId !== "string"
    || !OBSERVATION_RECEIPT_ID.test(root.graphObservationReceiptId)
    || typeof root.graphEvidenceReceiptId !== "string"
    || !GRAPH_EVIDENCE_RECEIPT_ID.test(root.graphEvidenceReceiptId)
    || typeof root.graphActivationEvidenceId !== "string"
    || !GRAPH_ACTIVATION_EVIDENCE_ID.test(root.graphActivationEvidenceId)
  ) {
    fail("INVALID_RECEIPT", "invalid-graph-receipt-id", "/graphEvidence");
  }
  const seed = closedRecord(root.graphActualSeed, ["id", "kind"], "/graphActualSeed");
  const expectedSeed = continuityThreadGraphRef(providerScope);
  if (
    seed.kind !== "thread"
    || typeof seed.id !== "string"
    || !THREAD_SEED_ID.test(seed.id)
    || seed.kind !== expectedSeed.kind
    || seed.id !== expectedSeed.id
  ) {
    fail("INVALID_RECEIPT", "invalid-graph-seed", "/graphActualSeed");
  }
  const nominations = closedRecord(
    root.nominations,
    ["core", "change", "support", "omitted", "omittedAssertionIdsDigest"],
    "/nominations"
  );
  const core = closedSafeInteger(nominations.core, 0, "/nominations/core");
  const change = closedSafeInteger(
    nominations.change,
    0,
    "/nominations/change"
  );
  const support = closedSafeInteger(
    nominations.support,
    0,
    "/nominations/support"
  );
  const omitted = closedSafeInteger(
    nominations.omitted,
    0,
    "/nominations/omitted"
  );
  if (
    core !== 1
    || change + support > MAX_RETAINED_PROVIDER_OPTIONALS
    || (
      omitted === 0
        ? nominations.omittedAssertionIdsDigest !== null
        : typeof nominations.omittedAssertionIdsDigest !== "string"
          || !OMITTED_DIGEST.test(nominations.omittedAssertionIdsDigest)
    )
  ) {
    fail("INVALID_RECEIPT", "invalid-nominations", "/nominations");
  }
  const budget = closedRecord(root.budget, [
    "maxAssertions",
    "maxConsideredAssertions",
    "maxDepth",
    "maxEstimatedTokens",
    "maxOutputBytes",
    "maxVisitedRefs"
  ], "/budget");
  if (
    JSON.stringify(budget)
    !== JSON.stringify(PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET)
  ) {
    fail("INVALID_RECEIPT", "invalid-budget", "/budget");
  }
  const snapshot = parseGraphSnapshotProvenance(root.snapshot, "/snapshot");
  const declaredFreshness = parseGraphDeclaredFreshness(
    root.declaredFreshness,
    "/declaredFreshness"
  );
  if (
    !("kind" in snapshot)
    || snapshot.kind !== "process-local-provider-head-revalidation"
    || !("basis" in declaredFreshness)
    || declaredFreshness.basis !== "provider-head-revalidation"
  ) {
    fail("INVALID_RECEIPT", "invalid-graph-provenance", "/snapshot");
  }
  try {
    assertGraphSnapshotFreshnessScopePair(
      snapshot,
      declaredFreshness,
      providerScope,
      {
        snapshot: "/snapshot",
        freshness: "/declaredFreshness",
        expectedScope: "/providerScope"
      }
    );
  } catch {
    fail("INVALID_RECEIPT", "graph-scope-mismatch", "/snapshot");
  }
  if (
    snapshot.revalidationReceiptId !== root.revalidationReceiptId
    || snapshot.providerId !== root.providerId
    || snapshot.providerVersion !== root.providerVersion
    || !sameProviderScope(snapshot.providerScope, providerScope)
    || declaredFreshness.revalidationReceiptId
      !== root.revalidationReceiptId
    || !sameProviderScope(declaredFreshness.providerScope, providerScope)
    || declaredFreshness.observedAt
      !== snapshot.subject.captureCompletedAt
    || declaredFreshness.assessedAt
      !== snapshot.head.captureCompletedAt
    || declaredFreshness.captureSpanMs
      !== (
        Date.parse(snapshot.head.captureCompletedAt)
        - Date.parse(snapshot.subject.captureCompletedAt)
      )
    || declaredFreshness.maxCaptureSpanMs < 1
    || declaredFreshness.maxCaptureSpanMs > 30_000
    || declaredFreshness.captureSpanMs
      > declaredFreshness.maxCaptureSpanMs
  ) {
    fail("INVALID_RECEIPT", "graph-cross-link-mismatch", "/snapshot");
  }
}

export function verifyProviderHeadRevalidatedGraphBindingReceipt(
  input: unknown
): ProviderHeadRevalidatedGraphBindingReceiptV1 {
  try {
    const canonical = canonicalizeImmutableEnvelope(
      input,
      "external-mutable",
      RECEIPT_SPEC
    );
    const envelope = canonical.envelope;
    if (
      typeof envelope.receiptId !== "string"
      || !RECEIPT_ID.test(envelope.receiptId)
      || canonical.contentId !== envelope.receiptId
    ) {
      fail("INVALID_RECEIPT", "invalid-receipt-id", "/receiptId");
    }
    const commonFields = [
      "schemaVersion",
      "receiptVersion",
      "receiptId",
      "authority",
      "status",
      "stage",
      "revalidationReceiptId",
      "providerId",
      "providerVersion",
      "providerScope",
      "providerFreshness",
      "canAssertFreshAtAssessment",
      "canAssertAbsenceWithinSnapshot",
      "canAssertCurrentWorldAbsence",
      "canAssertDurableProviderAuthority",
      "mintVerification",
      "mintVerificationSurvivesSerialization",
      "coverage"
    ];
    const graphFields = [
      "graphObservationReceiptId",
      "graphEvidenceReceiptId",
      "graphActivationEvidenceId",
      "graphActualSeed",
      "nominations",
      "budget",
      "snapshot",
      "declaredFreshness"
    ];
    const expectedFields = envelope.stage === "graph-evidence"
      ? [...commonFields, ...graphFields]
      : commonFields;
    const root = closedRecord(envelope, expectedFields, "");
    const expectedMintVerification = envelope.stage === "provider"
      ? "provider-owned-revalidation-artifact-verified-in-composing-process"
      : "provider-owned-two-capture-pair-verified-in-composing-process";
    if (envelope.mintVerification !== expectedMintVerification) {
      fail(
        "INVALID_RECEIPT",
        "stage-mint-verification-mismatch",
        "/mintVerification"
      );
    }
    if (
      envelope.schemaVersion !== 1
      || envelope.receiptVersion
        !== "muse.provider-head-revalidated-graph-evidence-receipt.v1"
      || envelope.authority !== "receipt-integrity-only"
      || envelope.providerId !== "muse.local-attunement-store"
      || envelope.providerVersion
        !== "muse.local-attunement-snapshot-provider.v1"
      || typeof envelope.revalidationReceiptId !== "string"
      || !REVALIDATION_RECEIPT_ID.test(envelope.revalidationReceiptId)
      || envelope.canAssertAbsenceWithinSnapshot !== false
      || envelope.canAssertCurrentWorldAbsence !== false
      || envelope.canAssertDurableProviderAuthority !== false
      || envelope.mintVerificationSurvivesSerialization !== false
      || (
        envelope.stage === "provider"
          ? envelope.status !== "abstained"
            || envelope.canAssertFreshAtAssessment !== false
          : envelope.stage === "revalidation"
            ? (
                envelope.status !== "stale"
                && envelope.status !== "abstained"
              ) || envelope.canAssertFreshAtAssessment !== false
            : envelope.stage === "graph-evidence"
              ? envelope.status !== "partial"
                || envelope.canAssertFreshAtAssessment !== true
              : true
      )
    ) {
      fail("INVALID_RECEIPT", "stage-field-mismatch", "/stage");
    }
    const providerScope = closedScope(envelope.providerScope, "/providerScope");
    const providerFreshness = closedRecord(
      envelope.providerFreshness,
      ["status", "reason"],
      "/providerFreshness"
    );
    const expectedReason = envelope.stage === "provider"
      ? ["requested-scope-unavailable", "source-read-failed", "source-capacity-exceeded"]
      : envelope.stage === "revalidation" && envelope.status === "abstained"
        ? ["requested-scope-unavailable", "source-read-failed", "source-capacity-exceeded"]
        : envelope.stage === "revalidation"
          ? ["head-state-changed", "capture-span-exceeded"]
          : ["head-state-matched-within-bound"];
    if (
      !expectedReason.includes(providerFreshness.reason as string)
      || (
        envelope.stage === "graph-evidence"
          ? providerFreshness.status !== "fresh-at-assessment"
          : providerFreshness.status !== "not-fresh"
      )
    ) {
      fail(
        "INVALID_RECEIPT",
        "stage-field-mismatch",
        "/providerFreshness"
      );
    }
    const coverage = closedRecord(
      envelope.coverage,
      ["status", "reasons"],
      "/coverage"
    );
    if (coverage.status !== envelope.status) {
      fail("INVALID_RECEIPT", "invalid-coverage", "/coverage/status");
    }
    if (envelope.stage !== "graph-evidence") {
      closedReasons(
        coverage.reasons,
        ["provider-head-revalidation-not-admitted-to-graph"],
        "/coverage/reasons"
      );
    } else {
      verifyClosedGraphFields(root, providerScope);
      const nominations = root.nominations as Readonly<{
        readonly omitted: number;
      }>;
      closedReasons(
        coverage.reasons,
        nominations.omitted > 0
          ? [
              "single-local-store",
              "two-endpoint-provider-revalidation",
              "fresh-at-assessment-only",
              "source-authority-unverified",
              "nomination-capacity-bounded",
              "graph-settlement-partial"
            ]
          : [
              "single-local-store",
              "two-endpoint-provider-revalidation",
              "fresh-at-assessment-only",
              "source-authority-unverified",
              "graph-settlement-partial"
            ],
        "/coverage/reasons"
      );
    }
    return envelope as ProviderHeadRevalidatedGraphBindingReceiptV1;
  } catch (cause) {
    if (cause instanceof ProviderHeadRevalidatedGraphEvidenceError) {
      throw cause;
    }
    if (
      cause instanceof CanonicalImmutableEnvelopeError
      && cause.code === "INTEGRITY_MISMATCH"
    ) {
      fail("INTEGRITY_MISMATCH", "receipt-id-mismatch", "/receiptId");
    }
    fail(
      "INVALID_RECEIPT",
      "invalid-receipt-envelope",
      cause instanceof CanonicalImmutableEnvelopeError
        ? cause.details.path
        : ""
    );
  }
}
