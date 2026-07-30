import {
  ContinuityScopedSourceObservationError,
  verifyScopedContinuitySourceObservation,
  type ContinuityScopedSourceObservationReceipt
} from "@muse/attunement/continuity-source-observations";

import {
  compareVerifiedContinuityObservationReceipts
} from "./continuity-observation-comparison.js";
import type {
  ExplainedContinuityChangeResult
} from "./continuity-change-contracts.js";
import {
  ContinuityObservationError,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  ContinuityResumeBoundaryError,
  verifyContinuityResumeBoundaryWithDependencies,
  type VerifiedContinuityResumeBoundaryDependencies
} from "./continuity-resume-boundary.js";
import {
  ResumeContextBudgetError,
  combineReservedResumeCosts,
  compileResumeContextFacts,
  reserveResumeBudget,
  serializeResumeContextFacts,
  type AdmittedResumeBudgetReservation,
  type CombinedReservedResumeCosts,
  type ResumeBudgetRequest6,
  type ResumeContextFactsV1,
  type ResumeCost6,
  type ResumeCostAxis,
  type ResumeFactAtomV1
} from "./continuity-resume-context-budget.js";
import {
  continuitySourceGraphPairMatches
} from "./continuity-source-graph-binding.js";
import {
  FairWitnessFrontierSettlementError,
  settleFairWitnessFrontier,
  type FairWitnessFrontierCompositionV1
} from "./fair-witness-frontier-settlement.js";
import {
  isProcessMintedProviderHeadRevalidatedGraphEvidence,
  type ProviderHeadRevalidatedGraphEvidenceV1
} from "./provider-head-revalidated-graph-evidence.js";
import {
  getThreadRootedRetainedWitnessInventory,
  type ThreadRootedRetainedWitnessInventoryV1
} from "./thread-rooted-witness-documents.js";
import type {
  GraphAssertion,
  GraphEpistemicClass,
  GraphPredicate,
  GraphRef
} from "@attunegraph/core";

export type ContinuityResumeContextOrchestratorErrorCode =
  | "INVALID_INPUT"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_MISMATCH"
  | "INTERNAL_POSTCONDITION_FAILED";

export class ContinuityResumeContextOrchestratorError extends Error {
  readonly code: ContinuityResumeContextOrchestratorErrorCode;
  readonly details: Readonly<{ readonly path: string; readonly reason: string }>;

  constructor(
    code: ContinuityResumeContextOrchestratorErrorCode,
    reason: string,
    path: string
  ) {
    super("continuity-resume-context-orchestrator-failed");
    this.name = "ContinuityResumeContextOrchestratorError";
    this.code = code;
    this.details = record({
      path: path.slice(0, 512),
      reason: reason.slice(0, 128)
    });
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

export type ResumeSupportingFactV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly factVersion: "muse.resume-supporting-fact.v1";
  readonly subject: GraphRef;
  readonly predicate: GraphPredicate;
  readonly object: GraphRef;
  readonly epistemicClass: GraphEpistemicClass;
  readonly validFrom?: string;
  readonly validTo?: string;
}>;

export type ContinuityResumeAgentContextV1 = Readonly<{
  readonly resumeContextFacts: ResumeContextFactsV1;
  readonly supportingFacts: readonly ResumeSupportingFactV1[];
  readonly contextStream: string;
}>;

type AbstentionReason =
  | "current-provider-stale"
  | "current-provider-abstained"
  | "change-comparison-abstained"
  | "no-usable-change-facts"
  | "mandatory-resume-context-does-not-fit";

export type ContinuityResumeContextAbstainedV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly status: "abstained";
  readonly reason: AbstentionReason;
  readonly providerStatus: ProviderHeadRevalidatedGraphEvidenceV1["status"];
  readonly providerStage: ProviderHeadRevalidatedGraphEvidenceV1["stage"];
  readonly agentContext: null;
  readonly firstViolatedAxis?: ResumeCostAxis;
  readonly mandatoryCost?: ResumeCost6;
}>;

export type ContinuityResumeContextPartialV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly status: "partial";
  readonly providerStatus: "partial";
  readonly providerStage: "graph-evidence";
  readonly comparisonStatus: "no-change" | "complete" | "partial";
  readonly reservation: AdmittedResumeBudgetReservation;
  readonly witnessStatus: "partial" | "abstained" | "capacity-invalid";
  readonly agentContext: ContinuityResumeAgentContextV1;
  readonly combinedCost?: CombinedReservedResumeCosts;
}>;

type ContinuityResumeContextAuditV1 = Readonly<{
  readonly previous: VerifiedContinuityResumeBoundaryDependencies;
  readonly currentSourceObservationReceipt:
    ContinuityScopedSourceObservationReceipt;
  readonly currentProviderResult:
    Extract<ProviderHeadRevalidatedGraphEvidenceV1, {
      readonly status: "partial";
    }>;
  readonly currentGraphObservationReceipt: ContinuityObservationReceipt;
  readonly changeResult: ExplainedContinuityChangeResult;
  readonly reservation: AdmittedResumeBudgetReservation;
  readonly inventory: ThreadRootedRetainedWitnessInventoryV1;
  readonly frontier: FairWitnessFrontierCompositionV1;
  readonly combinedCost?: CombinedReservedResumeCosts;
}>;

export type ContinuityResumeContextResultV1 =
  | ContinuityResumeContextAbstainedV1
  | ContinuityResumeContextPartialV1;

type NullRecord = Record<string, unknown>;

const OUTER_FIELDS = Object.freeze([
  "schemaVersion",
  "boundary",
  "previousSourceObservationReceipt",
  "previousGraphObservationReceipt",
  "currentProviderResult",
  "currentSourceObservationReceipt",
  "budget"
]);
const OUTER_REQUIRED = Object.freeze([
  "schemaVersion",
  "boundary",
  "previousSourceObservationReceipt",
  "previousGraphObservationReceipt",
  "currentProviderResult",
  "budget"
]);
const ZERO_COST = record({
  depth: 0,
  consideredAssertions: 0,
  visitedRefs: 0,
  assertions: 0,
  estimatedTokensV1: 0,
  outputBytes: 0
}) as ResumeCost6;

const CONTINUITY_RESUME_CONTEXT_AUDITS =
  new WeakMap<object, ContinuityResumeContextAuditV1>();

export function getContinuityResumeContextAudit(
  result: unknown
): ContinuityResumeContextAuditV1 | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return CONTINUITY_RESUME_CONTEXT_AUDITS.get(result);
}

function record<T extends NullRecord>(value: T): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as NullRecord, value)
  ) as Readonly<T>;
}

function array<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function fail(
  code: ContinuityResumeContextOrchestratorErrorCode,
  reason: string,
  path: string
): never {
  throw new ContinuityResumeContextOrchestratorError(code, reason, path);
}

function internal(reason: string, path: string): never {
  fail("INTERNAL_POSTCONDITION_FAILED", reason, path);
}

function sameScope(
  left: Readonly<{ readonly sourceId: string; readonly threadId: string }>,
  right: Readonly<{ readonly sourceId: string; readonly threadId: string }>
): boolean {
  return left.sourceId === right.sourceId
    && left.threadId === right.threadId;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function captureOuter(input: unknown): Readonly<{
  readonly values: Readonly<Record<string, unknown>>;
  readonly hasCurrentSource: boolean;
}> {
  try {
    if (typeof input !== "object" || input === null) {
      fail("INVALID_INPUT", "invalid-input-envelope", "");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("INVALID_INPUT", "invalid-input-envelope", "");
    }
    const keys = Reflect.ownKeys(input);
    if (
      keys.some((key) => typeof key !== "string")
      || keys.some((key) => !OUTER_FIELDS.includes(key as string))
      || OUTER_REQUIRED.some((field) => !keys.includes(field))
    ) {
      fail("INVALID_INPUT", "invalid-field-set", "");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        fail("INVALID_INPUT", "data-properties-required", `/${key}`);
      }
      values[key] = descriptor.value;
    }
    if (values.schemaVersion !== 1) {
      fail("INVALID_INPUT", "unsupported-schema-version", "/schemaVersion");
    }
    return record({
      values: Object.freeze(values),
      hasCurrentSource: keys.includes("currentSourceObservationReceipt")
    });
  } catch (cause) {
    if (cause instanceof ContinuityResumeContextOrchestratorError) throw cause;
    fail("INVALID_INPUT", "input-inspection-failed", "");
  }
}

function canonicalBudget(raw: unknown): ResumeBudgetRequest6 {
  try {
    const reservation = reserveResumeBudget(
      raw as ResumeBudgetRequest6,
      ZERO_COST
    );
    if (reservation.status !== "admitted") {
      internal("zero-cost-budget-not-admitted", "/budget");
    }
    return reservation.requested;
  } catch (cause) {
    if (cause instanceof ContinuityResumeContextOrchestratorError) throw cause;
    if (cause instanceof ResumeContextBudgetError) {
      fail("INVALID_INPUT", "invalid-budget", "/budget");
    }
    fail("INVALID_INPUT", "invalid-budget", "/budget");
  }
}

function verifyPrevious(
  values: Readonly<Record<string, unknown>>
): VerifiedContinuityResumeBoundaryDependencies {
  try {
    return verifyContinuityResumeBoundaryWithDependencies({
      boundary: values.boundary,
      previousSourceObservationReceipt:
        values.previousSourceObservationReceipt,
      previousGraphObservationReceipt:
        values.previousGraphObservationReceipt
    });
  } catch (cause) {
    if (cause instanceof ContinuityResumeBoundaryError) {
      if (cause.code === "DEPENDENCY_MISMATCH") {
        fail("DEPENDENCY_MISMATCH", "previous-boundary-dependency-mismatch", "/boundary");
      }
      if (cause.code === "INTERNAL_POSTCONDITION_FAILED") {
        internal("previous-boundary-postcondition-failed", "/boundary");
      }
      fail("INVALID_DEPENDENCY", "previous-boundary-invalid", "/boundary");
    }
    fail("INVALID_DEPENDENCY", "previous-boundary-invalid", "/boundary");
  }
}

function verifyCurrentSource(
  input: unknown
): ContinuityScopedSourceObservationReceipt {
  try {
    return verifyScopedContinuitySourceObservation(input);
  } catch (cause) {
    if (cause instanceof ContinuityScopedSourceObservationError) {
      fail("INVALID_DEPENDENCY", "current-source-invalid", "/currentSourceObservationReceipt");
    }
    fail("INVALID_DEPENDENCY", "current-source-invalid", "/currentSourceObservationReceipt");
  }
}

function verifyCurrentGraph(
  input: unknown
): ContinuityObservationReceipt {
  try {
    return verifyContinuityObservation(input);
  } catch (cause) {
    if (cause instanceof ContinuityObservationError) {
      fail("INVALID_DEPENDENCY", "current-graph-invalid", "/currentProviderResult/graphObservationReceipt");
    }
    fail("INVALID_DEPENDENCY", "current-graph-invalid", "/currentProviderResult/graphObservationReceipt");
  }
}

function assertProviderCrossLinks(
  provider: Extract<ProviderHeadRevalidatedGraphEvidenceV1, {
    readonly status: "partial";
  }>,
  graph: ContinuityObservationReceipt
): void {
  const { receipt, graphEvidence, revalidationReceipt } = provider;
  if (
    receipt.status !== "partial"
    || receipt.stage !== "graph-evidence"
    || receipt.revalidationReceiptId !== revalidationReceipt.receiptId
    || receipt.graphObservationReceiptId !== graph.receiptId
    || receipt.graphEvidenceReceiptId !== graphEvidence.receipt.receiptId
    || receipt.graphActivationEvidenceId
      !== graphEvidence.activationEvidence.evidenceId
    || graphEvidence.receipt.sourceObservationReceiptId !== graph.receiptId
    || graphEvidence.receipt.sourceProjectionVersion
      !== graph.projection.projectionVersion
    || !sameScope(graph.projection.scope, receipt.providerScope)
    || !sameScope(graphEvidence.receipt.sourceScope, receipt.providerScope)
    || !sameJson(receipt.graphActualSeed, graphEvidence.receipt.actualSeed)
  ) {
    internal("provider-cross-link-mismatch", "/currentProviderResult");
  }
}

function assertInventoryCrossLinks(
  provider: Extract<ProviderHeadRevalidatedGraphEvidenceV1, {
    readonly status: "partial";
  }>,
  inventory: ThreadRootedRetainedWitnessInventoryV1
): void {
  const legacy = provider.graphEvidence.legacyCompilation;
  const { manifest, registry } = inventory;
  if (
    !sameScope(manifest.scope, provider.receipt.providerScope)
    || !sameJson(manifest.snapshot, provider.receipt.snapshot)
    || !sameJson(manifest.declaredFreshness, provider.receipt.declaredFreshness)
    || manifest.requestId !== legacy.receipt.requestId
    || manifest.coreEntryId !== registry.core.entry.entryId
    || manifest.frontierReceiptId !== legacy.frontier?.receipt.receiptId
    || manifest.frontierOrderId !== legacy.frontier?.order.orderId
    || manifest.frontierSettlementResultId !== legacy.settlement?.resultId
    || manifest.counts.witnessedOptionals !== registry.optionals.length
    || manifest.counts.frontierDispositions !== registry.optionals.length
    || !sameJson(manifest.seed, provider.graphEvidence.receipt.actualSeed)
  ) {
    internal("retained-inventory-cross-link-mismatch", "/orchestrationEvidence/inventory");
  }
}

function atom(assertion: GraphAssertion): ResumeSupportingFactV1 {
  return record({
    schemaVersion: 1 as const,
    factVersion: "muse.resume-supporting-fact.v1" as const,
    subject: record({
      id: assertion.subject.id,
      kind: assertion.subject.kind
    }) as GraphRef,
    predicate: assertion.predicate,
    object: record({
      id: assertion.object.id,
      kind: assertion.object.kind
    }) as GraphRef,
    epistemicClass: assertion.epistemicClass,
    ...(assertion.validFrom === undefined
      ? {}
      : { validFrom: assertion.validFrom }),
    ...(assertion.validTo === undefined ? {} : { validTo: assertion.validTo })
  }) as ResumeSupportingFactV1;
}

function semanticKey(value: ResumeFactAtomV1 | ResumeSupportingFactV1): string {
  return JSON.stringify([
    value.subject.kind,
    value.subject.id,
    value.predicate,
    value.object.kind,
    value.object.id,
    value.epistemicClass,
    value.validFrom ?? null,
    value.validTo ?? null
  ]);
}

function supportingFacts(
  facts: ResumeContextFactsV1,
  inventory: ThreadRootedRetainedWitnessInventoryV1,
  frontier: FairWitnessFrontierCompositionV1
): readonly ResumeSupportingFactV1[] {
  if (frontier.settlement.status !== "partial") return array([]);
  const seen = new Set<string>();
  for (const change of facts.changes) {
    if (change.before !== null) seen.add(semanticKey(change.before));
    seen.add(semanticKey(change.after));
  }
  const output: ResumeSupportingFactV1[] = [];
  const admit = (assertion: GraphAssertion): void => {
    const support = atom(assertion);
    const key = semanticKey(support);
    if (seen.has(key)) return;
    seen.add(key);
    output.push(support);
  };
  admit(inventory.registry.core.focusAssertion);
  const byNomination = new Map(
    inventory.registry.optionals.map((item) => [
      item.entry.nominationId,
      item
    ])
  );
  const admitted = frontier.receipt.dispositions
    .filter((item): item is Extract<
      typeof item,
      { readonly status: "budget-admitted" }
    > => item.status === "budget-admitted")
    .sort((left, right) => left.rank - right.rank);
  for (const disposition of admitted) {
    const item = byNomination.get(disposition.nominationId);
    if (
      item === undefined
      || item.entry.documentId !== disposition.documentId
      || item.entry.focusAssertionId !== disposition.focusAssertionId
    ) {
      internal("supporting-fact-selection-mismatch", "/agentContext/supportingFacts");
    }
    admit(item.focusAssertion);
  }
  return array(output);
}

function settlementCost(
  frontier: FairWitnessFrontierCompositionV1
): ResumeCost6 | undefined {
  if (frontier.settlement.status === "invalid-input") return undefined;
  const settlement = frontier.settlement.settlement;
  const counters = settlement.ledger.counters;
  return record({
    depth: counters.maxDepth,
    consideredAssertions: counters.consideredAssertions,
    visitedRefs: counters.visitedRefs,
    assertions: counters.selectedAssertions,
    estimatedTokensV1: settlement.estimatedTokens,
    outputBytes: settlement.totalOutputBytes
  }) as ResumeCost6;
}

function agentContext(
  facts: ResumeContextFactsV1,
  supports: readonly ResumeSupportingFactV1[],
  requested: ResumeBudgetRequest6
): ContinuityResumeAgentContextV1 {
  const contextStream = serializeResumeContextFacts(facts)
    + supports.map((support) => `${JSON.stringify(support)}\n`).join("");
  const bytes = new TextEncoder().encode(contextStream).byteLength;
  if (
    bytes > requested.maxOutputBytes
    || Math.ceil(bytes / 4) > requested.maxEstimatedTokens
  ) {
    internal("final-context-stream-exceeds-request", "/agentContext/contextStream");
  }
  return record({
    resumeContextFacts: facts,
    supportingFacts: supports,
    contextStream
  }) as ContinuityResumeAgentContextV1;
}

function abstained(
  provider: ProviderHeadRevalidatedGraphEvidenceV1,
  reason: AbstentionReason,
  budget?: Readonly<{
    readonly firstViolatedAxis: ResumeCostAxis;
    readonly mandatoryCost: ResumeCost6;
  }>
): ContinuityResumeContextAbstainedV1 {
  return record({
    schemaVersion: 1 as const,
    status: "abstained" as const,
    reason,
    providerStatus: provider.status,
    providerStage: provider.stage,
    agentContext: null,
    ...(budget === undefined ? {} : {
      firstViolatedAxis: budget.firstViolatedAxis,
      mandatoryCost: budget.mandatoryCost
    })
  }) as ContinuityResumeContextAbstainedV1;
}

export function compileContinuityResumeContext(
  input: unknown
): ContinuityResumeContextResultV1 {
  const outer = captureOuter(input);
  const rawProvider = outer.values.currentProviderResult;
  if (!isProcessMintedProviderHeadRevalidatedGraphEvidence(rawProvider)) {
    fail(
      "INVALID_DEPENDENCY",
      "provider-result-not-process-minted",
      "/currentProviderResult"
    );
  }
  const provider = rawProvider as ProviderHeadRevalidatedGraphEvidenceV1;
  const requested = canonicalBudget(outer.values.budget);
  const previous = verifyPrevious(outer.values);

  if (!sameScope(provider.receipt.providerScope, previous.boundary.scope)) {
    fail(
      "DEPENDENCY_MISMATCH",
      "provider-scope-mismatch",
      "/currentProviderResult/receipt/providerScope"
    );
  }
  if (provider.status !== "partial") {
    if (outer.hasCurrentSource) {
      fail(
        "INVALID_INPUT",
        "current-source-must-be-absent",
        "/currentSourceObservationReceipt"
      );
    }
    return abstained(
      provider,
      provider.status === "stale"
        ? "current-provider-stale"
        : "current-provider-abstained"
    );
  }
  if (!outer.hasCurrentSource) {
    fail(
      "INVALID_INPUT",
      "current-source-required",
      "/currentSourceObservationReceipt"
    );
  }

  const currentSource = verifyCurrentSource(
    outer.values.currentSourceObservationReceipt
  );
  const currentGraph = verifyCurrentGraph(provider.graphObservationReceipt);
  assertProviderCrossLinks(provider, currentGraph);
  if (
    !sameScope(currentSource.scope, provider.receipt.providerScope)
    || !continuitySourceGraphPairMatches(currentSource, currentGraph)
  ) {
    fail(
      "DEPENDENCY_MISMATCH",
      "current-source-graph-mismatch",
      "/currentSourceObservationReceipt"
    );
  }

  const changeResult = compareVerifiedContinuityObservationReceipts(
    previous.previousGraphObservationReceipt,
    currentGraph
  );
  if (changeResult.status === "abstained") {
    return abstained(provider, "change-comparison-abstained");
  }
  if (changeResult.status === "partial" && changeResult.changes.length === 0) {
    return abstained(provider, "no-usable-change-facts");
  }

  let compilation;
  try {
    compilation = compileResumeContextFacts({
      previous,
      currentGraphObservationReceipt: currentGraph,
      changeResult
    });
  } catch (cause) {
    if (cause instanceof ResumeContextBudgetError) {
      internal("resume-fact-compilation-failed", "/orchestrationEvidence/changeResult");
    }
    throw cause;
  }
  let reservation;
  try {
    reservation = reserveResumeBudget(requested, compilation.mandatoryCost);
  } catch (cause) {
    if (cause instanceof ResumeContextBudgetError) {
      internal("resume-budget-reservation-failed", "/orchestrationEvidence/reservation");
    }
    throw cause;
  }
  if (reservation.status === "exceeded") {
    return abstained(provider, "mandatory-resume-context-does-not-fit", {
      firstViolatedAxis: reservation.firstViolatedAxis,
      mandatoryCost: reservation.mandatoryCost
    });
  }

  const inventory = getThreadRootedRetainedWitnessInventory(
    provider.graphEvidence.legacyCompilation
  );
  if (inventory === undefined) {
    internal(
      "retained-inventory-unavailable",
      "/currentProviderResult/graphEvidence/legacyCompilation"
    );
  }
  assertInventoryCrossLinks(provider, inventory);
  let frontier: FairWitnessFrontierCompositionV1;
  try {
    frontier = settleFairWitnessFrontier({
      budget: {
        maxDepth: reservation.residual.depth,
        maxConsideredAssertions:
          reservation.residual.consideredAssertions,
        maxVisitedRefs: reservation.residual.visitedRefs,
        maxAssertions: reservation.residual.assertions,
        maxEstimatedTokens: reservation.residual.estimatedTokensV1,
        maxOutputBytes: reservation.residual.outputBytes
      },
      coreDocument: inventory.registry.core.document,
      declaredFreshness: inventory.manifest.declaredFreshness,
      optionals: inventory.registry.optionals.map((item) => ({
        document: item.document,
        focusAssertion: item.focusAssertion,
        nominationId: item.entry.nominationId,
        observedAt: item.entry.observedAt
      })),
      scope: inventory.manifest.scope,
      seed: inventory.manifest.seed,
      snapshot: inventory.manifest.snapshot,
      threadRootedRequestId: inventory.manifest.requestId
    });
  } catch (cause) {
    if (cause instanceof FairWitnessFrontierSettlementError) {
      internal("fair-frontier-settlement-failed", "/orchestrationEvidence/frontier");
    }
    throw cause;
  }

  const settledCost = settlementCost(frontier);
  let combinedCost: CombinedReservedResumeCosts | undefined;
  if (settledCost !== undefined) {
    try {
      combinedCost = combineReservedResumeCosts(reservation, settledCost);
    } catch (cause) {
      if (cause instanceof ResumeContextBudgetError) {
        internal("combined-cost-postcondition-failed", "/combinedCost");
      }
      throw cause;
    }
  }
  const supports = supportingFacts(compilation.facts, inventory, frontier);
  const context = agentContext(compilation.facts, supports, requested);
  const witnessStatus = frontier.settlement.status === "invalid-input"
    ? "capacity-invalid" as const
    : frontier.settlement.status;
  const audit = record({
    previous,
    currentSourceObservationReceipt: currentSource,
    currentProviderResult: provider,
    currentGraphObservationReceipt: currentGraph,
    changeResult,
    reservation,
    inventory,
    frontier,
    ...(combinedCost === undefined ? {} : { combinedCost })
  }) as ContinuityResumeContextAuditV1;
  const result = record({
    schemaVersion: 1 as const,
    status: "partial" as const,
    providerStatus: "partial" as const,
    providerStage: "graph-evidence" as const,
    comparisonStatus: changeResult.status as "no-change" | "complete" | "partial",
    reservation,
    witnessStatus,
    agentContext: context,
    ...(combinedCost === undefined ? {} : { combinedCost })
  }) as ContinuityResumeContextPartialV1;
  CONTINUITY_RESUME_CONTEXT_AUDITS.set(result, audit);
  return result;
}
