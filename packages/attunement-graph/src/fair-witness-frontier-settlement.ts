import {
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import type { SettlementAxis } from "./candidate-settlement-ledger.js";
import {
  type FairFrontierBundleOrderV1,
  type FairFrontierLane,
  orderFairFrontierBundles
} from "./fair-frontier-bundle-order.js";
import {
  ScopedProofDocumentSettlementError,
  type ScopedProofDocumentSettlementResultV1,
  compileScopedProofDocumentSettlement
} from "./scoped-proof-document-settlement.js";
import type {
  GraphAssertion,
  GraphPredicate
} from "./types.js";
import {
  GraphSnapshotProvenanceError,
  assertGraphSnapshotFreshnessScopePair,
  type GraphDeclaredFreshnessV1,
  type GraphSnapshotProvenanceV1
} from "./graph-snapshot-provenance.js";

const RECEIPT_SPEC = Object.freeze({
  hashDomain: "muse.attunement-graph.fair-witness-frontier-receipt.v1",
  idField: "receiptId",
  idPrefix: "muse-fair-witness-frontier-receipt:sha256:"
} as const);

const DOCUMENT_ID = /^muse-scoped-proof-document:sha256:[0-9a-f]{64}$/u;
const RECEIPT_ID = /^muse-fair-witness-frontier-receipt:sha256:[0-9a-f]{64}$/u;
const RAW = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type Scope = Readonly<{
  readonly sourceId: string;
  readonly threadId: string;
}>;
type Snapshot = GraphSnapshotProvenanceV1;
type Freshness = GraphDeclaredFreshnessV1;
type Budget = Readonly<{
  readonly maxAssertions: number;
  readonly maxConsideredAssertions: number;
  readonly maxDepth: number;
  readonly maxEstimatedTokens: number;
  readonly maxOutputBytes: number;
  readonly maxVisitedRefs: number;
}>;
type Seed = Readonly<{ readonly id: string; readonly kind: "thread" }>;
type Document = Record<string, unknown>;

export type FairWitnessFrontierCandidate = Readonly<{
  readonly document: Document;
  readonly focusAssertion: GraphAssertion;
  readonly nominationId: string;
  readonly observedAt: string;
}>;

export type FairWitnessFrontierDisposition =
  | Readonly<{
      readonly candidateId: string;
      readonly documentId: string;
      readonly focusAssertionId: string;
      readonly nominationId: string;
      readonly predicate: GraphPredicate;
      readonly status: "lane-undetermined";
    }>
  | Readonly<{
      readonly candidateId: string;
      readonly documentId: string;
      readonly focusAssertionId: string;
      readonly lane: FairFrontierLane;
      readonly nominationId: string;
      readonly predicate: GraphPredicate;
      readonly rank: number;
      readonly status: "budget-admitted";
    }>
  | Readonly<{
      readonly candidateId: string;
      readonly documentId: string;
      readonly firstViolatedAxis: SettlementAxis;
      readonly focusAssertionId: string;
      readonly lane: FairFrontierLane;
      readonly nominationId: string;
      readonly predicate: GraphPredicate;
      readonly rank: number;
      readonly status: "capacity-excluded";
    }>
  | Readonly<{
      readonly candidateId: string;
      readonly documentId: string;
      readonly focusAssertionId: string;
      readonly lane: FairFrontierLane;
      readonly nominationId: string;
      readonly predicate: GraphPredicate;
      readonly rank: number;
      readonly status: "core-not-admitted";
    }>
  | Readonly<{
      readonly candidateId: string;
      readonly documentId: string;
      readonly firstViolatedAxis: "token" | "bytes";
      readonly focusAssertionId: string;
      readonly lane: FairFrontierLane;
      readonly nominationId: string;
      readonly predicate: GraphPredicate;
      readonly rank: number;
      readonly status: "capacity-invalid";
    }>;

type CoverageReason =
  | "bounded-witness-pool-only"
  | "caller-declared-snapshot"
  | "caller-declared-freshness"
  | "provider-capture-snapshot-integrity-only"
  | "provider-head-revalidation-snapshot-integrity-only"
  | "fresh-at-assessment-only"
  | "freshness-unassessed"
  | "source-authority-not-independently-verified"
  | "focus-predicate-lane-mapping-v1"
  | "core-not-admitted"
  | "minimum-settlement-envelope-exceeds-budget";

export type FairWitnessFrontierReceiptV1 = Readonly<{
  readonly coreCandidateId: string;
  readonly coreDocumentId: string;
  readonly coverage: Readonly<{
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly reasons: readonly CoverageReason[];
    readonly status: "partial" | "abstained";
  }>;
  readonly dispositions: readonly FairWitnessFrontierDisposition[];
  readonly metrics: Readonly<{
    readonly attemptedCandidates: number;
    readonly budgetAdmitted: number;
    readonly capacityExcluded: number;
    readonly capacityInvalid: number;
    readonly coreNotAdmitted: number;
    readonly laneUndetermined: number;
    readonly ordered: number;
    readonly settlementInvocations: number;
    readonly witnessedOptional: number;
  }>;
  readonly minimumAbstentionAxis?: "token" | "bytes";
  readonly orderId: string;
  readonly orderRequestId: string;
  readonly receiptId: string;
  readonly receiptVersion: "muse.fair-witness-frontier-receipt.v1";
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly seed: Seed;
  readonly settlementResultId: string;
  readonly snapshot: Snapshot;
  readonly status: "partial" | "abstained" | "invalid-input";
  readonly threadRootedRequestId: string;
}>;

export type FairWitnessFrontierCompositionV1 = Readonly<{
  readonly order: FairFrontierBundleOrderV1;
  readonly receipt: FairWitnessFrontierReceiptV1;
  readonly settlement: ScopedProofDocumentSettlementResultV1;
}>;

export class FairWitnessFrontierSettlementError extends Error {
  readonly code = "INTERNAL_POSTCONDITION_FAILED" as const;
  readonly details: Readonly<{ readonly reason: string }>;

  constructor(reason: string) {
    super("fair-witness-frontier-settlement-failed");
    this.name = "FairWitnessFrontierSettlementError";
    this.details = Object.freeze({ reason });
    delete (this as { stack?: unknown }).stack;
    for (const key of ["message", "name", "code", "details"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: key === "code" || key === "details",
        value: this[key],
        writable: false
      });
    }
  }
}

type PreparedCandidate = FairWitnessFrontierCandidate & Readonly<{
  readonly candidateId: string;
  readonly documentId: string;
  readonly lane?: FairFrontierLane;
}>;

function internal(reason: string): never {
  throw new FairWitnessFrontierSettlementError(reason);
}

function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor && key !== "length") {
        freezeTree(descriptor.value);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function mutableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  const root = value as Record<string, unknown>;
  return `{${Object.keys(root).sort(RAW).map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(root[key])}`
  ).join(",")}}`;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    internal("invalid-internal-document-shape");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) internal("invalid-internal-document-shape");
  return value;
}

export function deriveFairWitnessLaneV1(
  predicate: GraphPredicate
): FairFrontierLane | undefined {
  switch (predicate) {
    case "NEXT_STEP_FOR":
    case "CONTEXT_FOR":
    case "PRECEDED":
    case "DELIVERED_FOR":
      return "continuity";
    case "REVISION_OF":
    case "SUPERSEDES":
      return "change";
    case "SUPPORTED_BY":
    case "DERIVED_FROM":
    case "OBSERVED_DURING":
    case "PRODUCED_OUTCOME":
    case "CORRELATES_WITH":
      return "evidence";
    case "PROPOSES_POLICY":
    case "SCOPED_TO":
    case "GOVERNED_BY":
      return "policy";
    case "AUTHORIZED_BY":
    case "PERFORMED":
      return "authority";
    case "LINKED_TO":
      return undefined;
  }
}

function prepareCandidate(value: FairWitnessFrontierCandidate): PreparedCandidate {
  const document = record(value.document);
  const documentId = document.documentId;
  if (typeof documentId !== "string" || !DOCUMENT_ID.test(documentId)) {
    internal("invalid-internal-document-id");
  }
  if (document.observedAt !== value.observedAt) {
    internal("focus-observation-mismatch");
  }
  const proof = record(document.proof);
  const paths = array(proof.paths);
  if (paths.length !== 1) internal("focus-path-count-mismatch");
  const path = array(paths[0]);
  const last = path.at(-1);
  if (last === undefined) internal("focus-path-empty");
  const lastStep = record(last);
  if (lastStep.assertionId !== value.focusAssertion.id) {
    internal("focus-path-mismatch");
  }
  const assertions = array(proof.assertions);
  const focused = assertions
    .map((item) => record(item))
    .find((item) => record(item.assertion).id === value.focusAssertion.id);
  if (
    focused === undefined
    || canonicalValue(focused.assertion) !== canonicalValue(value.focusAssertion)
  ) {
    internal("focus-assertion-mismatch");
  }
  return freezeRecord({
    ...value,
    candidateId: `optional:${documentId.slice(-64)}`,
    documentId,
    lane: deriveFairWitnessLaneV1(value.focusAssertion.predicate)
  });
}

function coreIdentity(document: Document): {
  readonly candidateId: string;
  readonly documentId: string;
} {
  const documentId = record(document).documentId;
  if (typeof documentId !== "string" || !DOCUMENT_ID.test(documentId)) {
    internal("invalid-internal-core-document-id");
  }
  return {
    candidateId: `core:${documentId.slice(-64)}`,
    documentId
  };
}

function settle(
  input: FairWitnessFrontierInput,
  selected: readonly PreparedCandidate[]
): ScopedProofDocumentSettlementResultV1 {
  try {
    return compileScopedProofDocumentSettlement(mutableJson({
      budget: input.budget,
      core: {
        document: input.coreDocument,
        localStatus: { status: "eligible" }
      },
      declaredFreshness: input.declaredFreshness,
      operatorVersion: "muse.scoped-proof-document-settlement.v1",
      optionals: selected.map((item) => ({
        document: item.document,
        localStatus: { status: "eligible" }
      })),
      schemaVersion: 1,
      scope: input.scope,
      snapshot: input.snapshot
    }));
  } catch (cause) {
    if (cause instanceof ScopedProofDocumentSettlementError) {
      internal(`settlement-oracle-failed:${cause.details.reason}:${cause.details.path}`);
    }
    internal("settlement-oracle-failed");
  }
}

function admittedDocumentIds(
  result: ScopedProofDocumentSettlementResultV1
): Set<string> {
  if (result.status !== "partial") return new Set();
  return new Set(result.documents.map((document) => document.documentId));
}

function subsetAdmitted(
  result: ScopedProofDocumentSettlementResultV1,
  coreDocumentId: string,
  selected: readonly PreparedCandidate[]
): boolean {
  if (result.status !== "partial") return false;
  const admitted = admittedDocumentIds(result);
  return (
    admitted.size === selected.length + 1
    && admitted.has(coreDocumentId)
    && selected.every((item) => admitted.has(item.documentId))
  );
}

function violatedAxis(
  result: ScopedProofDocumentSettlementResultV1
): SettlementAxis {
  if (result.status === "invalid-input") {
    return result.capacity.error.firstViolatedAxis;
  }
  const failed = result.settlement.ledger.entries.filter((entry) =>
    entry.terminalState === "failed"
  );
  if (failed.length === 1) {
    const entry = failed[0];
    if (entry?.terminalState !== "failed") internal("axis-postcondition-failed");
    return entry.reasonId.slice("budget:".length) as SettlementAxis;
  }
  if (failed.length > 1) internal("axis-postcondition-failed");
  const axis = result.settlement.ledger.firstViolatedAxis;
  if (axis === "token" || axis === "bytes") return axis;
  internal("axis-postcondition-failed");
}

function baseDisposition(candidate: PreparedCandidate): {
  readonly candidateId: string;
  readonly documentId: string;
  readonly focusAssertionId: string;
  readonly nominationId: string;
  readonly predicate: GraphPredicate;
} {
  return {
    candidateId: candidate.candidateId,
    documentId: candidate.documentId,
    focusAssertionId: candidate.focusAssertion.id,
    nominationId: candidate.nominationId,
    predicate: candidate.focusAssertion.predicate
  };
}

function metrics(
  dispositions: readonly FairWitnessFrontierDisposition[],
  attemptedCandidates: number,
  settlementInvocations: number
): FairWitnessFrontierReceiptV1["metrics"] {
  const count = (status: FairWitnessFrontierDisposition["status"]): number =>
    dispositions.filter((item) => item.status === status).length;
  return freezeRecord({
    attemptedCandidates,
    budgetAdmitted: count("budget-admitted"),
    capacityExcluded: count("capacity-excluded"),
    capacityInvalid: count("capacity-invalid"),
    coreNotAdmitted: count("core-not-admitted"),
    laneUndetermined: count("lane-undetermined"),
    ordered: dispositions.filter((item) => item.status !== "lane-undetermined").length,
    settlementInvocations,
    witnessedOptional: dispositions.length
  });
}

function captureReceipt(
  body: Record<string, unknown>
): FairWitnessFrontierReceiptV1 {
  const first = canonicalizeImmutableEnvelope(
    mutableJson(body),
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
    || !RECEIPT_ID.test(second.contentId)
  ) {
    internal("receipt-postcondition-failed");
  }
  return second.envelope as unknown as FairWitnessFrontierReceiptV1;
}

function coverage(
  status: FairWitnessFrontierReceiptV1["status"],
  snapshot: Snapshot,
  freshness: Freshness
): FairWitnessFrontierReceiptV1["coverage"] {
  const reasons: CoverageReason[] = [
    "bounded-witness-pool-only",
    snapshot.authority === "receipt-integrity-only"
      ? snapshot.kind === "process-local-provider-head-revalidation"
        ? "provider-head-revalidation-snapshot-integrity-only"
        : "provider-capture-snapshot-integrity-only"
      : "caller-declared-snapshot",
    ...(freshness.status === "unassessed"
      ? ["freshness-unassessed" as const]
      : "basis" in freshness
        ? ["fresh-at-assessment-only" as const]
        : ["caller-declared-freshness" as const]),
    "source-authority-not-independently-verified",
    "focus-predicate-lane-mapping-v1"
  ];
  if (status === "abstained") reasons.push("core-not-admitted");
  if (status === "invalid-input") {
    reasons.push("minimum-settlement-envelope-exceeds-budget");
  }
  return freezeRecord({
    canAssertAbsenceWithinSnapshot: false as const,
    canAssertCurrentWorldAbsence: false as const,
    reasons: Object.freeze(reasons),
    status: status === "partial" ? "partial" as const : "abstained" as const
  });
}

function verifyComposition(
  input: FairWitnessFrontierInput,
  order: FairFrontierBundleOrderV1,
  receipt: FairWitnessFrontierReceiptV1,
  settlement: ScopedProofDocumentSettlementResultV1
): void {
  try {
    assertGraphSnapshotFreshnessScopePair(
      input.snapshot,
      input.declaredFreshness,
      input.scope,
      {
        snapshot: "/snapshot",
        freshness: "/declaredFreshness",
        expectedScope: "/scope"
      }
    );
  } catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) internal("snapshot-freshness-pair-postcondition-failed");
    throw cause;
  }
  const dispositions = receipt.dispositions;
  const nominationIds = dispositions.map((item) => item.nominationId);
  const candidateIds = dispositions.map((item) => item.candidateId);
  const documentIds = dispositions.map((item) => item.documentId);
  if (
    new Set(nominationIds).size !== dispositions.length
    || new Set(candidateIds).size !== dispositions.length
    || new Set(documentIds).size !== dispositions.length
    || receipt.threadRootedRequestId !== input.threadRootedRequestId
    || receipt.orderId !== order.orderId
    || receipt.orderRequestId !== order.requestId
    || receipt.settlementResultId !== settlement.resultId
  ) {
    internal("receipt-conservation-postcondition-failed");
  }
  const ordered = dispositions
    .filter((item): item is Exclude<
      FairWitnessFrontierDisposition,
      { status: "lane-undetermined" }
    > => item.status !== "lane-undetermined")
    .sort((left, right) => left.rank - right.rank);
  if (
    ordered.length !== order.entries.length
    || ordered.some((item, index) => item.rank !== index)
    || order.entries.some((entry, index) =>
      entry.rank !== index
      || entry.candidateId !== ordered[index]?.candidateId
      || entry.bundleId !== ordered[index]?.documentId
      || entry.lane !== ordered[index]?.lane
    )
  ) {
    internal("order-link-postcondition-failed");
  }
  const metric = receipt.metrics;
  if (
    metric.witnessedOptional !== dispositions.length
    || metric.laneUndetermined
      + metric.budgetAdmitted
      + metric.capacityExcluded
      + metric.coreNotAdmitted
      + metric.capacityInvalid !== metric.witnessedOptional
    || metric.ordered !== order.entries.length
    || metric.ordered !== metric.budgetAdmitted
      + metric.capacityExcluded
      + metric.coreNotAdmitted
      + metric.capacityInvalid
    || metric.settlementInvocations !== metric.attemptedCandidates + 1
    || metric.settlementInvocations > order.entries.length + 1
  ) {
    internal("metric-postcondition-failed");
  }
  const finalAdmitted = admittedDocumentIds(settlement);
  finalAdmitted.delete(receipt.coreDocumentId);
  const receiptAdmitted = new Set(
    dispositions
      .filter((item) => item.status === "budget-admitted")
      .map((item) => item.documentId)
  );
  if (
    finalAdmitted.size !== receiptAdmitted.size
    || [...receiptAdmitted].some((id) => !finalAdmitted.has(id))
    || (receipt.status === "partial") !== (settlement.status === "partial")
    || (receipt.status === "invalid-input") !== (settlement.status === "invalid-input")
  ) {
    internal("admission-parity-postcondition-failed");
  }
}

export type FairWitnessFrontierInput = Readonly<{
  readonly budget: Budget;
  readonly coreDocument: Document;
  readonly declaredFreshness: Freshness;
  readonly optionals: readonly FairWitnessFrontierCandidate[];
  readonly scope: Scope;
  readonly seed: Seed;
  readonly snapshot: Snapshot;
  readonly threadRootedRequestId: string;
}>;

export function settleFairWitnessFrontier(
  input: FairWitnessFrontierInput
): FairWitnessFrontierCompositionV1 {
  try {
    assertGraphSnapshotFreshnessScopePair(
      input.snapshot,
      input.declaredFreshness,
      input.scope,
      {
        snapshot: "/snapshot",
        freshness: "/declaredFreshness",
        expectedScope: "/scope"
      }
    );
  } catch {
    internal("snapshot-freshness-pair-postcondition-failed");
  }
  const core = coreIdentity(input.coreDocument);
  const prepared = input.optionals.map(prepareCandidate);
  if (
    new Set(prepared.map((item) => item.nominationId)).size !== prepared.length
    || new Set(prepared.map((item) => item.candidateId)).size !== prepared.length
  ) {
    internal("duplicate-internal-candidate");
  }
  const derivable = prepared.filter((item): item is PreparedCandidate & {
    readonly lane: FairFrontierLane;
  } => item.lane !== undefined);
  let order: FairFrontierBundleOrderV1;
  try {
    order = orderFairFrontierBundles(mutableJson({
      operatorVersion: "muse.fair-frontier-bundle-order.v1",
      opportunities: derivable.map((item) => ({
        bundleId: item.documentId,
        candidateId: item.candidateId,
        lane: item.lane,
        observedAt: item.observedAt
      })),
      schemaVersion: 1,
      scope: input.scope,
      seed: input.seed,
      snapshot: input.snapshot
    }));
  } catch {
    internal("fair-order-postcondition-failed");
  }
  const byCandidate = new Map(prepared.map((item) => [item.candidateId, item]));
  const dispositions: FairWitnessFrontierDisposition[] = prepared
    .filter((item) => item.lane === undefined)
    .map((item) => freezeRecord({
      ...baseDisposition(item),
      status: "lane-undetermined" as const
    }));
  let settlementInvocations = 1;
  let attemptedCandidates = 0;
  let finalSettlement = settle(input, []);
  const selected: PreparedCandidate[] = [];
  if (finalSettlement.status === "partial") {
    for (const entry of order.entries) {
      const candidate = byCandidate.get(entry.candidateId);
      if (candidate?.lane === undefined) internal("order-candidate-postcondition-failed");
      attemptedCandidates += 1;
      settlementInvocations += 1;
      const trialSet = [...selected, candidate];
      const trial = settle(input, trialSet);
      if (subsetAdmitted(trial, core.documentId, trialSet)) {
        selected.push(candidate);
        finalSettlement = trial;
        dispositions.push(freezeRecord({
          ...baseDisposition(candidate),
          lane: candidate.lane,
          rank: entry.rank,
          status: "budget-admitted" as const
        }));
        continue;
      }
      dispositions.push(freezeRecord({
        ...baseDisposition(candidate),
        firstViolatedAxis: violatedAxis(trial),
        lane: candidate.lane,
        rank: entry.rank,
        status: "capacity-excluded" as const
      }));
    }
  } else if (finalSettlement.status === "invalid-input") {
    const axis = finalSettlement.capacity.error.firstViolatedAxis;
    for (const entry of order.entries) {
      const candidate = byCandidate.get(entry.candidateId);
      if (candidate?.lane === undefined) internal("order-candidate-postcondition-failed");
      dispositions.push(freezeRecord({
        ...baseDisposition(candidate),
        firstViolatedAxis: axis,
        lane: candidate.lane,
        rank: entry.rank,
        status: "capacity-invalid" as const
      }));
    }
  } else {
    for (const entry of order.entries) {
      const candidate = byCandidate.get(entry.candidateId);
      if (candidate?.lane === undefined) internal("order-candidate-postcondition-failed");
      dispositions.push(freezeRecord({
        ...baseDisposition(candidate),
        lane: candidate.lane,
        rank: entry.rank,
        status: "core-not-admitted" as const
      }));
    }
  }
  dispositions.sort((left, right) => RAW(left.nominationId, right.nominationId));
  const status = finalSettlement.status;
  const body: Record<string, unknown> = {
    coreCandidateId: core.candidateId,
    coreDocumentId: core.documentId,
    coverage: coverage(status, input.snapshot, input.declaredFreshness),
    dispositions,
    metrics: metrics(dispositions, attemptedCandidates, settlementInvocations),
    orderId: order.orderId,
    orderRequestId: order.requestId,
    receiptVersion: "muse.fair-witness-frontier-receipt.v1",
    schemaVersion: 1,
    scope: input.scope,
    seed: input.seed,
    settlementResultId: finalSettlement.resultId,
    snapshot: input.snapshot,
    status,
    threadRootedRequestId: input.threadRootedRequestId
  };
  if (status === "invalid-input") {
    body.minimumAbstentionAxis = finalSettlement.capacity.error.firstViolatedAxis;
  }
  const receipt = captureReceipt(body);
  verifyComposition(input, order, receipt, finalSettlement);
  return freezeTree(freezeRecord({
    order,
    receipt,
    settlement: finalSettlement
  })) as FairWitnessFrontierCompositionV1;
}
