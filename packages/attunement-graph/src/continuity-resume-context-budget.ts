import type { ArtifactReference } from "@muse/attunement";

import {
  CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
  type ContinuityChangeTemporalBasis,
  type ExplainedContinuityChange,
  type ExplainedContinuityChangeResult
} from "./continuity-change-contracts.js";
import type { ContinuityObservationReceipt } from "./continuity-observation.js";
import type {
  VerifiedContinuityResumeBoundaryDependencies
} from "./continuity-resume-boundary.js";
import { PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET } from "./provider-bound-graph-evidence.js";
import type {
  GraphAssertion,
  GraphEpistemicClass,
  GraphPredicate,
  GraphRef
} from "./types.js";

export const RESUME_CONTEXT_FACTS_VERSION =
  "muse.resume-context-facts.v1" as const;

export type ResumeContextBudgetErrorCode =
  "INTERNAL_POSTCONDITION_FAILED";

export type ResumeContextBudgetErrorReason =
  | "cross-boundary-mismatch"
  | "invalid-status-count"
  | "missing-assertion-support"
  | "duplicate-change"
  | "unsafe-cost"
  | "invalid-request"
  | "forged-reservation"
  | "settlement-exceeds-residual"
  | "cost-overflow"
  | "final-cost-exceeds-request";

export class ResumeContextBudgetError extends Error {
  readonly code: ResumeContextBudgetErrorCode;
  readonly details: Readonly<{ readonly reason: ResumeContextBudgetErrorReason }>;

  constructor(reason: ResumeContextBudgetErrorReason) {
    super("continuity-resume-context-budget-failed");
    this.name = "ResumeContextBudgetError";
    this.code = "INTERNAL_POSTCONDITION_FAILED";
    this.details = frozenRecord({ reason });
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

export type ResumeFactAtomV1 = Readonly<{
  readonly subject: GraphRef;
  readonly predicate: GraphPredicate;
  readonly object: GraphRef;
  readonly epistemicClass: GraphEpistemicClass;
  readonly validFrom?: string;
  readonly validTo?: string;
}>;

export type ResumeChangeFactV1 = Readonly<{
  readonly kind: "added" | "revised";
  readonly temporalBasis: ContinuityChangeTemporalBasis;
  readonly before: ResumeFactAtomV1 | null;
  readonly after: ResumeFactAtomV1;
}>;

export type ResumeContextFactsAuthorityV1 = Readonly<{
  readonly basis: "bounded-verified-observation-comparison";
  readonly canAssertCurrentWorldTruth: false;
  readonly canAssertSourceCompleteness: false;
  readonly canGrantActionAuthority: false;
}>;

export type ResumeContextFactsV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly factsVersion: typeof RESUME_CONTEXT_FACTS_VERSION;
  readonly status: "partial" | "no-change";
  readonly authority: ResumeContextFactsAuthorityV1;
  readonly boundaryObservedAt: string;
  readonly currentObservedAt: string;
  readonly previousNextStep: ArtifactReference & {
    readonly artifactType: "task";
    readonly providerId: "local";
    readonly role: "next-step";
  };
  readonly changes: readonly ResumeChangeFactV1[];
}>;

export type ResumeCost6 = Readonly<{
  readonly depth: number;
  readonly consideredAssertions: number;
  readonly visitedRefs: number;
  readonly assertions: number;
  readonly estimatedTokensV1: number;
  readonly outputBytes: number;
}>;

export type ResumeBudgetRequest6 = Readonly<{
  readonly maxDepth: number;
  readonly maxConsideredAssertions: number;
  readonly maxVisitedRefs: number;
  readonly maxAssertions: number;
  readonly maxEstimatedTokens: number;
  readonly maxOutputBytes: number;
}>;

export type ResumeCostAxis = keyof ResumeCost6;

export type ExceededResumeBudgetReservation = Readonly<{
  readonly status: "exceeded";
  readonly firstViolatedAxis: ResumeCostAxis;
  readonly requested: ResumeBudgetRequest6;
  readonly mandatoryCost: ResumeCost6;
}>;

export type AdmittedResumeBudgetReservation = Readonly<{
  readonly status: "admitted";
  readonly requested: ResumeBudgetRequest6;
  readonly mandatoryCost: ResumeCost6;
  readonly residual: ResumeCost6;
}>;

export type ResumeBudgetReservation =
  | ExceededResumeBudgetReservation
  | AdmittedResumeBudgetReservation;

export type CombinedReservedResumeCosts = Readonly<{
  readonly requested: ResumeBudgetRequest6;
  readonly mandatoryCost: ResumeCost6;
  readonly residual: ResumeCost6;
  readonly settlementCost: ResumeCost6;
  readonly finalCost: ResumeCost6;
}>;

export type ResumeContextFactsCompilationV1 = Readonly<{
  readonly facts: ResumeContextFactsV1;
  readonly backingAssertionIds: readonly string[];
  readonly mandatoryCost: ResumeCost6;
}>;

export interface CompileResumeContextFactsInput {
  readonly previous: VerifiedContinuityResumeBoundaryDependencies;
  readonly currentGraphObservationReceipt: ContinuityObservationReceipt;
  readonly changeResult: ExplainedContinuityChangeResult;
}

type NullRecord = Record<string, unknown>;

function fail(reason: ResumeContextBudgetErrorReason): never {
  throw new ResumeContextBudgetError(reason);
}

function frozenRecord<T extends NullRecord>(value: T): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as NullRecord, value)
  ) as Readonly<T>;
}

function frozenArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function graphRef(value: GraphRef): GraphRef {
  return frozenRecord({ id: value.id, kind: value.kind }) as unknown as GraphRef;
}

function artifactReference(
  value: VerifiedContinuityResumeBoundaryDependencies["boundary"]["previousNextStep"]
): ResumeContextFactsV1["previousNextStep"] {
  return frozenRecord({
    artifactId: value.artifactId,
    artifactType: "task",
    providerId: "local",
    role: "next-step"
  }) as ResumeContextFactsV1["previousNextStep"];
}

function atom(value: GraphAssertion): ResumeFactAtomV1 {
  return frozenRecord({
    subject: graphRef(value.subject),
    predicate: value.predicate,
    object: graphRef(value.object),
    epistemicClass: value.epistemicClass,
    ...(value.validFrom === undefined ? {} : { validFrom: value.validFrom }),
    ...(value.validTo === undefined ? {} : { validTo: value.validTo })
  }) as ResumeFactAtomV1;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function changeKey(change: ExplainedContinuityChange): readonly string[] {
  return [
    change.assertion.id,
    change.kind,
    change.replacedAssertionId ?? "",
    change.temporalBasis
  ];
}

function compareChanges(
  left: ExplainedContinuityChange,
  right: ExplainedContinuityChange
): number {
  const leftKey = changeKey(left);
  const rightKey = changeKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const compared = compareCodePoints(leftKey[index]!, rightKey[index]!);
    if (compared !== 0) return compared;
  }
  return 0;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => compareCodePoints(left, right));
  return `{${entries.map(([key, item]) =>
    `${JSON.stringify(key)}:${canonicalValue(item)}`
  ).join(",")}}`;
}

function assertionsEqual(left: GraphAssertion, right: GraphAssertion): boolean {
  return canonicalValue(left) === canonicalValue(right);
}

function exactAssertion(
  assertions: readonly GraphAssertion[],
  expected: GraphAssertion
): GraphAssertion {
  const matches = assertions.filter((candidate) => candidate.id === expected.id);
  if (
    matches.length !== 1
    || !assertionsEqual(matches[0]!, expected)
  ) {
    fail("missing-assertion-support");
  }
  return matches[0]!;
}

function sameScope(
  left: { readonly sourceId: string; readonly threadId: string },
  right: { readonly sourceId: string; readonly threadId: string }
): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

function exactNextStep(
  left: VerifiedContinuityResumeBoundaryDependencies["boundary"]["previousNextStep"],
  right: unknown
): boolean {
  if (typeof right !== "object" || right === null) return false;
  const candidate = right as Partial<typeof left>;
  return candidate.artifactId === left.artifactId
    && candidate.artifactType === left.artifactType
    && candidate.providerId === left.providerId
    && candidate.role === left.role;
}

function assertCrossLinks(
  input: CompileResumeContextFactsInput
): void {
  const { previous, currentGraphObservationReceipt: current, changeResult } = input;
  const { boundary, previousSourceObservationReceipt: source } = previous;
  const graph = previous.previousGraphObservationReceipt;
  const sourceObservation = source.observation;
  const nextStep = sourceObservation.projection.nextStep;

  if (
    !sameScope(boundary.scope, source.scope)
    || !sameScope(boundary.scope, graph.projection.scope)
    || !sameScope(boundary.scope, current.projection.scope)
    || !sameScope(boundary.scope, changeResult.scope)
    || !sameScope(boundary.scope, changeResult.boundary.scope)
    || boundary.observedAt !== sourceObservation.observedAt
    || boundary.observedAt !== graph.observedAt
    || boundary.sourceObservationReceiptId !== source.receiptId
    || boundary.graphObservationReceiptId !== graph.receiptId
    || boundary.graphSourceVersion !== graph.projection.sourceVersion
    || boundary.graphProjectionVersion !== graph.projection.projectionVersion
    || !exactNextStep(boundary.previousNextStep, nextStep)
    || changeResult.previous.sourceObservedAt !== graph.observedAt
    || changeResult.previous.sourceVersion !== graph.projection.sourceVersion
    || changeResult.previous.projectionVersion !== graph.projection.projectionVersion
    || changeResult.current.sourceObservedAt !== current.observedAt
    || changeResult.current.sourceVersion !== current.projection.sourceVersion
    || changeResult.current.projectionVersion !== current.projection.projectionVersion
    || changeResult.boundary.authority !== "caller-declared-observation"
    || changeResult.boundary.observedAt !== graph.observedAt
    || changeResult.boundary.sourceRef.namespace
      !== CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE
    || changeResult.boundary.sourceRef.id !== graph.projection.sourceVersion
    || changeResult.boundary.sourceRef.version
      !== graph.projection.projectionVersion
  ) {
    fail("cross-boundary-mismatch");
  }
}

function checkedCost(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("unsafe-cost");
  return value;
}

function cost(
  depth: number,
  consideredAssertions: number,
  visitedRefs: number,
  assertions: number,
  estimatedTokensV1: number,
  outputBytes: number
): ResumeCost6 {
  return frozenRecord({
    depth: checkedCost(depth),
    consideredAssertions: checkedCost(consideredAssertions),
    visitedRefs: checkedCost(visitedRefs),
    assertions: checkedCost(assertions),
    estimatedTokensV1: checkedCost(estimatedTokensV1),
    outputBytes: checkedCost(outputBytes)
  }) as ResumeCost6;
}

function request(value: ResumeBudgetRequest6): ResumeBudgetRequest6 {
  const output = frozenRecord({
    maxDepth: checkedCost(value.maxDepth),
    maxConsideredAssertions: checkedCost(value.maxConsideredAssertions),
    maxVisitedRefs: checkedCost(value.maxVisitedRefs),
    maxAssertions: checkedCost(value.maxAssertions),
    maxEstimatedTokens: checkedCost(value.maxEstimatedTokens),
    maxOutputBytes: checkedCost(value.maxOutputBytes)
  }) as ResumeBudgetRequest6;
  if (
    output.maxDepth > PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET.maxDepth
    || output.maxConsideredAssertions
      > PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET.maxConsideredAssertions
    || output.maxVisitedRefs > PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET.maxVisitedRefs
    || output.maxAssertions > PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET.maxAssertions
    || output.maxEstimatedTokens
      > PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET.maxEstimatedTokens
    || output.maxOutputBytes > PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET.maxOutputBytes
  ) {
    fail("invalid-request");
  }
  return output;
}

function copiedCost(value: ResumeCost6): ResumeCost6 {
  return cost(
    value.depth,
    value.consideredAssertions,
    value.visitedRefs,
    value.assertions,
    value.estimatedTokensV1,
    value.outputBytes
  );
}

const AXES: readonly (readonly [
  ResumeCostAxis,
  keyof ResumeBudgetRequest6
])[] = Object.freeze([
  ["depth", "maxDepth"],
  ["consideredAssertions", "maxConsideredAssertions"],
  ["visitedRefs", "maxVisitedRefs"],
  ["assertions", "maxAssertions"],
  ["estimatedTokensV1", "maxEstimatedTokens"],
  ["outputBytes", "maxOutputBytes"]
]);

export function reserveResumeBudget(
  requestedInput: ResumeBudgetRequest6,
  mandatoryInput: ResumeCost6
): ResumeBudgetReservation {
  const requested = request(requestedInput);
  const mandatoryCost = copiedCost(mandatoryInput);
  for (const [costAxis, requestAxis] of AXES) {
    if (mandatoryCost[costAxis] > requested[requestAxis]) {
      return frozenRecord({
        status: "exceeded",
        firstViolatedAxis: costAxis,
        requested,
        mandatoryCost
      }) as ExceededResumeBudgetReservation;
    }
  }
  const residual = cost(
    requested.maxDepth,
    requested.maxConsideredAssertions - mandatoryCost.consideredAssertions,
    requested.maxVisitedRefs - mandatoryCost.visitedRefs,
    requested.maxAssertions - mandatoryCost.assertions,
    requested.maxEstimatedTokens - mandatoryCost.estimatedTokensV1,
    requested.maxOutputBytes - mandatoryCost.outputBytes
  );
  return frozenRecord({
    status: "admitted",
    requested,
    mandatoryCost,
    residual
  }) as AdmittedResumeBudgetReservation;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalValue(left) === canonicalValue(right);
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) fail("cost-overflow");
  return result;
}

export function combineReservedResumeCosts(
  admittedReservation: AdmittedResumeBudgetReservation,
  settlementInput: ResumeCost6
): CombinedReservedResumeCosts {
  if (
    !Object.isFrozen(admittedReservation)
    || !Object.isFrozen(admittedReservation.requested)
    || !Object.isFrozen(admittedReservation.mandatoryCost)
    || !Object.isFrozen(admittedReservation.residual)
  ) {
    fail("forged-reservation");
  }
  let recomputed: ResumeBudgetReservation;
  try {
    recomputed = reserveResumeBudget(
      admittedReservation.requested,
      admittedReservation.mandatoryCost
    );
  } catch {
    fail("forged-reservation");
  }
  if (
    recomputed.status !== "admitted"
    || !sameCanonicalValue(recomputed, admittedReservation)
  ) {
    fail("forged-reservation");
  }

  const settlementCost = copiedCost(settlementInput);
  for (const [axis] of AXES) {
    if (settlementCost[axis] > recomputed.residual[axis]) {
      fail("settlement-exceeds-residual");
    }
  }
  const finalCost = cost(
    Math.max(recomputed.mandatoryCost.depth, settlementCost.depth),
    checkedAdd(
      recomputed.mandatoryCost.consideredAssertions,
      settlementCost.consideredAssertions
    ),
    checkedAdd(
      recomputed.mandatoryCost.visitedRefs,
      settlementCost.visitedRefs
    ),
    checkedAdd(
      recomputed.mandatoryCost.assertions,
      settlementCost.assertions
    ),
    checkedAdd(
      recomputed.mandatoryCost.estimatedTokensV1,
      settlementCost.estimatedTokensV1
    ),
    checkedAdd(
      recomputed.mandatoryCost.outputBytes,
      settlementCost.outputBytes
    )
  );
  for (const [costAxis, requestAxis] of AXES) {
    if (finalCost[costAxis] > recomputed.requested[requestAxis]) {
      fail("final-cost-exceeds-request");
    }
  }
  return frozenRecord({
    requested: recomputed.requested,
    mandatoryCost: recomputed.mandatoryCost,
    residual: recomputed.residual,
    settlementCost,
    finalCost
  }) as CombinedReservedResumeCosts;
}

export function serializeResumeContextFacts(
  facts: ResumeContextFactsV1
): string {
  return `${JSON.stringify(facts)}\n`;
}

export function compileResumeContextFacts(
  input: CompileResumeContextFactsInput
): ResumeContextFactsCompilationV1 {
  assertCrossLinks(input);
  const { previous, currentGraphObservationReceipt: current, changeResult } = input;
  const count = changeResult.changes.length;
  const validChangedStatus = (
    (changeResult.status === "complete" || changeResult.status === "partial")
    && count > 0
  );
  const validNoChangeStatus = changeResult.status === "no-change" && count === 0;
  if (!validChangedStatus && !validNoChangeStatus) {
    fail("invalid-status-count");
  }

  const orderedChanges = [...changeResult.changes].sort(compareChanges);
  const seenChangeIds = new Set<string>();
  const backingIds = new Set<string>();
  const changes = orderedChanges.map((change): ResumeChangeFactV1 => {
    if (seenChangeIds.has(change.assertion.id)) fail("duplicate-change");
    seenChangeIds.add(change.assertion.id);
    const currentAssertion = exactAssertion(
      current.projection.assertions,
      change.assertion
    );
    backingIds.add(currentAssertion.id);
    if (change.kind === "added") {
      if (change.replacedAssertionId !== undefined) {
        fail("missing-assertion-support");
      }
      return frozenRecord({
        kind: "added",
        temporalBasis: change.temporalBasis,
        before: null,
        after: atom(currentAssertion)
      }) as ResumeChangeFactV1;
    }
    if (change.replacedAssertionId === undefined) {
      fail("missing-assertion-support");
    }
    const previousAssertion = previous.previousGraphObservationReceipt
      .projection.assertions
      .find((candidate) => candidate.id === change.replacedAssertionId);
    if (!previousAssertion) fail("missing-assertion-support");
    exactAssertion(
      previous.previousGraphObservationReceipt.projection.assertions,
      previousAssertion
    );
    backingIds.add(previousAssertion.id);
    return frozenRecord({
      kind: "revised",
      temporalBasis: change.temporalBasis,
      before: atom(previousAssertion),
      after: atom(currentAssertion)
    }) as ResumeChangeFactV1;
  });

  const facts = frozenRecord({
    schemaVersion: 1,
    factsVersion: RESUME_CONTEXT_FACTS_VERSION,
    status: validNoChangeStatus ? "no-change" : "partial",
    authority: frozenRecord({
      basis: "bounded-verified-observation-comparison",
      canAssertCurrentWorldTruth: false,
      canAssertSourceCompleteness: false,
      canGrantActionAuthority: false
    }),
    boundaryObservedAt: previous.boundary.observedAt,
    currentObservedAt: current.observedAt,
    previousNextStep: artifactReference(previous.boundary.previousNextStep),
    changes: frozenArray(changes)
  }) as ResumeContextFactsV1;
  const backingAssertionIds = frozenArray([...backingIds].sort(compareCodePoints));
  const outputBytes = new TextEncoder()
    .encode(serializeResumeContextFacts(facts)).byteLength;
  const mandatoryCost = cost(
    changeResult.diagnostics.maxDepthReached,
    changeResult.diagnostics.consideredAssertions,
    changeResult.diagnostics.visitedRefs,
    backingAssertionIds.length,
    Math.ceil(outputBytes / 4),
    outputBytes
  );
  return frozenRecord({
    facts,
    backingAssertionIds,
    mandatoryCost
  }) as ResumeContextFactsCompilationV1;
}
