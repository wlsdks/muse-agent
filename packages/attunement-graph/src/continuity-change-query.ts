import { createHash } from "node:crypto";

import {
  continuityThreadGraphRef,
  diffContinuityProjections,
  type ContinuityGraphProjection,
  type ContinuityProjectionInput,
  type ContinuityProjectionScope
} from "./continuity-projection.js";
import {
  CONTINUITY_CHANGE_LIMITS,
  buildContinuityChangeCandidates,
  buildContinuityPathTree,
  classifyContinuityTemporal,
  continuitySupportEligible,
  explainContinuityPath,
  isContinuityNoOp,
  sameContinuityScope
} from "./continuity-change-semantics.js";
import {
  continuityCanonicalInstant,
  continuityDataObject,
  continuityDataString,
  inspectContinuityData,
  parseContinuityProjectionScope,
  queryError
} from "./continuity-change-primitives.js";
import {
  prepareContinuitySourceObservation
} from "./continuity-source-observation.js";
import type {
  GraphAssertion,
  GraphDirection,
  GraphEvidenceRef,
  GraphRef
} from "./types.js";
import { evidenceRefKey } from "./validation.js";

export { CONTINUITY_CHANGE_LIMITS } from "./continuity-change-semantics.js";
export {
  ContinuityChangeQueryError
} from "./continuity-change-primitives.js";
export type {
  ContinuityChangeQueryErrorCode
} from "./continuity-change-primitives.js";

export const CONTINUITY_CHANGE_QUERY_VERSION =
  "continuity-change-query-v1" as const;
export const CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE =
  "muse.attunement.continuity-projection" as const;

export interface ContinuityChangeBoundary {
  readonly authority: "caller-declared-observation";
  readonly observedAt: string;
  readonly schemaVersion: 1;
  readonly scope: ContinuityProjectionScope;
  readonly sourceRef: GraphEvidenceRef;
}

export type ContinuityChangeTemporalBasis = "world-valid" | "learned-after";
export type ContinuityChangeKind = "added" | "revised";
export type ContinuityChangeStatus =
  | "complete"
  | "partial"
  | "no-change"
  | "abstained";

export type ContinuityChangeAbstentionCode =
  | "AMBIGUOUS_REVISION"
  | "REMOVAL_TIME_UNKNOWN"
  | "OUTSIDE_INTERVAL"
  | "NO_PATH_WITHIN_DEPTH"
  | "INCONSISTENT_OBSERVATION"
  | "VISITED_REF_BUDGET_EXCEEDED"
  | "OUTPUT_BUDGET_EXCEEDED";

export interface ContinuityChangePathStep {
  readonly assertionId: string;
  readonly derivation: GraphAssertion["derivation"];
  readonly direction: Exclude<GraphDirection, "both">;
  readonly epistemicClass: GraphAssertion["epistemicClass"];
  readonly object: GraphRef;
  readonly predicate: GraphAssertion["predicate"];
  readonly sourceRefs: readonly GraphEvidenceRef[];
  readonly subject: GraphRef;
}

export interface ExplainedContinuityChange {
  readonly assertion: GraphAssertion;
  readonly kind: ContinuityChangeKind;
  readonly path: readonly ContinuityChangePathStep[];
  readonly replacedAssertionId?: string;
  readonly temporalBasis: ContinuityChangeTemporalBasis;
}

export interface ContinuityChangeAbstention {
  readonly affectedCount: number;
  readonly affectedAssertionIds: readonly string[];
  readonly code: ContinuityChangeAbstentionCode;
  readonly global: boolean;
}

export interface ContinuityChangeObservationDiagnostics {
  readonly descriptorsInspected: number;
  readonly projectedAssertions: number;
  readonly sourceRecordsInspected: number;
  readonly stringBytesInspected: number;
}

export interface ContinuityChangeDiagnostics {
  readonly abstainedCount: number;
  readonly answeredCount: number;
  readonly candidateCount: number;
  readonly complete: boolean;
  readonly consideredAssertions: number;
  readonly current: ContinuityChangeObservationDiagnostics;
  readonly diffComparedAssertions: number;
  readonly embeddingCalls: 0;
  readonly maxDepthReached: number;
  readonly modelCalls: 0;
  readonly previous: ContinuityChangeObservationDiagnostics;
  readonly rawDeltaCount: number;
  readonly visitedRefs: number;
}

export interface ContinuityChangeObservationRef {
  readonly projectionVersion: string;
  readonly sourceObservedAt: string;
  readonly sourceVersion: string;
}

export interface ExplainedContinuityChangeResult {
  readonly abstentions: readonly ContinuityChangeAbstention[];
  readonly boundary: ContinuityChangeBoundary;
  readonly changes: readonly ExplainedContinuityChange[];
  readonly current: ContinuityChangeObservationRef;
  readonly diagnostics: ContinuityChangeDiagnostics;
  readonly previous: ContinuityChangeObservationRef;
  readonly queryVersion: typeof CONTINUITY_CHANGE_QUERY_VERSION;
  readonly resultId: string;
  readonly schemaVersion: 1;
  readonly scope: ContinuityProjectionScope;
  readonly status: ContinuityChangeStatus;
}

function parseEvidenceRef(value: unknown, label: string): GraphEvidenceRef {
  const record = continuityDataObject(value, label, [
    "id",
    "namespace",
    "version"
  ]);
  return Object.freeze({
    id: continuityDataString(record.id, `${label}.id`),
    namespace: continuityDataString(record.namespace, `${label}.namespace`),
    version: continuityDataString(record.version, `${label}.version`)
  });
}

function parseBoundary(value: unknown): ContinuityChangeBoundary {
  const record = continuityDataObject(value, "boundary", [
    "authority",
    "observedAt",
    "schemaVersion",
    "scope",
    "sourceRef"
  ]);
  if (record.schemaVersion !== 1) {
    queryError("INVALID_INPUT", "boundary.schemaVersion must be 1");
  }
  if (record.authority !== "caller-declared-observation") {
    queryError("INVALID_INPUT", "boundary.authority is invalid");
  }
  return Object.freeze({
    authority: "caller-declared-observation" as const,
    observedAt: continuityCanonicalInstant(
      record.observedAt,
      "boundary.observedAt"
    ),
    schemaVersion: 1 as const,
    scope: parseContinuityProjectionScope(record.scope, "boundary.scope"),
    sourceRef: parseEvidenceRef(record.sourceRef, "boundary.sourceRef")
  });
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) output[key] = canonicalValue(child);
  }
  return output;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function instant(value: string): number {
  return new Date(value).getTime();
}

function observationRef(
  input: ContinuityProjectionInput,
  projection: ContinuityGraphProjection
): ContinuityChangeObservationRef {
  return Object.freeze({
    projectionVersion: projection.projectionVersion,
    sourceObservedAt: input.sourceObservedAt,
    sourceVersion: projection.sourceVersion
  });
}

function makeResult(
  base: Omit<ExplainedContinuityChangeResult, "resultId">
): ExplainedContinuityChangeResult {
  const frozen = Object.freeze(base);
  return Object.freeze({ ...frozen, resultId: digest(frozen) });
}

function statusFor(answered: number, abstained: number): ContinuityChangeStatus {
  if (answered > 0 && abstained === 0) return "complete";
  if (answered > 0) return "partial";
  return "abstained";
}

export function explainContinuityChanges(
  input: unknown
): ExplainedContinuityChangeResult {
  inspectContinuityData(
    input,
    "continuity change input",
    CONTINUITY_CHANGE_LIMITS.maxDescriptors * 2 + 128,
    CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes * 2 + 16_384
  );
  const envelope = continuityDataObject(input, "continuity change input", [
    "boundary",
    "current",
    "previous",
    "schemaVersion"
  ]);
  if (envelope.schemaVersion !== 1) {
    queryError("INVALID_INPUT", "continuity change input.schemaVersion must be 1");
  }
  const previous = prepareContinuitySourceObservation(
    envelope.previous,
    "previous"
  );
  const current = prepareContinuitySourceObservation(envelope.current, "current");
  const boundary = parseBoundary(envelope.boundary);
  if (
    !sameContinuityScope(previous.input.scope, current.input.scope)
    || !sameContinuityScope(previous.input.scope, boundary.scope)
  ) {
    queryError("INVALID_INPUT", "previous, current, and boundary scopes must match");
  }
  if (
    previous.input.sourceObservedAt !== boundary.observedAt
    || instant(current.input.sourceObservedAt) < instant(boundary.observedAt)
  ) {
    queryError("INVALID_INPUT", "boundary observation interval is invalid");
  }
  const expectedBoundaryRef: GraphEvidenceRef = {
    id: previous.projection.sourceVersion,
    namespace: CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
    version: previous.projection.projectionVersion
  };
  if (evidenceRefKey(boundary.sourceRef) !== evidenceRefKey(expectedBoundaryRef)) {
    queryError("INVALID_INPUT", "boundary source ref does not bind the previous projection");
  }

  const base = {
    boundary,
    current: observationRef(current.input, current.projection),
    previous: observationRef(previous.input, previous.projection),
    queryVersion: CONTINUITY_CHANGE_QUERY_VERSION,
    schemaVersion: 1 as const,
    scope: previous.projection.scope
  };
  const emptyDiagnostics = (
    rawDeltaCount: number,
    candidateCount: number,
    answeredCount: number,
    abstainedCount: number,
    consideredAssertions: number,
    visitedRefs: number,
    maxDepthReached: number,
    complete: boolean
  ): ContinuityChangeDiagnostics => Object.freeze({
    abstainedCount,
    answeredCount,
    candidateCount,
    complete,
    consideredAssertions,
    current: current.diagnostics,
    diffComparedAssertions:
      previous.projection.assertions.length + current.projection.assertions.length,
    embeddingCalls: 0 as const,
    maxDepthReached,
    modelCalls: 0 as const,
    previous: previous.diagnostics,
    rawDeltaCount,
    visitedRefs
  });

  const inconsistent = [
    ...previous.projection.assertions
      .filter((item) =>
        instant(item.recordedAt) > instant(previous.input.sourceObservedAt)
      ),
    ...current.projection.assertions
      .filter((item) =>
        instant(item.recordedAt) > instant(current.input.sourceObservedAt)
      )
  ].map((item) => item.id).sort();

  if (isContinuityNoOp(previous.projection, current.projection)) {
    if (inconsistent.length > 0) {
      return makeResult({
        ...base,
        abstentions: Object.freeze([Object.freeze({
          affectedCount: 0,
          affectedAssertionIds: Object.freeze(inconsistent),
          code: "INCONSISTENT_OBSERVATION" as const,
          global: true
        })]),
        changes: Object.freeze([]),
        diagnostics: emptyDiagnostics(0, 0, 0, 1, 0, 0, 0, false),
        status: "abstained"
      });
    }
    return makeResult({
      ...base,
      abstentions: Object.freeze([]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(0, 0, 0, 0, 0, 0, 0, true),
      status: "no-change"
    });
  }

  const delta = diffContinuityProjections(previous.projection, current.projection);
  const rawDeltaCount = delta.append.length + delta.forgetAssertionIds.length;
  if (rawDeltaCount > CONTINUITY_CHANGE_LIMITS.maxRawDelta) {
    queryError("RAW_DELTA_BUDGET_EXCEEDED", "raw delta exceeds query budget", {
      limit: CONTINUITY_CHANGE_LIMITS.maxRawDelta,
      rawDeltaCount
    });
  }
  const previousById = new Map(
    previous.projection.assertions.map((item) => [item.id, item])
  );
  const removals = delta.forgetAssertionIds
    .map((id) => previousById.get(id))
    .filter((item): item is GraphAssertion => Boolean(item));
  const candidates = buildContinuityChangeCandidates(removals, delta.append);
  const candidateIds = candidates.flatMap((candidate) => [
    ...candidate.removals.map((item) => item.id),
    ...candidate.additions.map((item) => item.id)
  ]).sort();
  if (inconsistent.length > 0) {
    return makeResult({
      ...base,
      abstentions: Object.freeze([Object.freeze({
        affectedCount: candidates.length,
        affectedAssertionIds: Object.freeze(candidateIds),
        code: "INCONSISTENT_OBSERVATION" as const,
        global: true
      })]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(
        rawDeltaCount,
        candidates.length,
        0,
        1,
        0,
        0,
        0,
        false
      ),
      status: "abstained"
    });
  }

  const appendedIds = new Set(delta.append.map((item) => item.id));
  const unchangedIds = new Set(delta.unchangedAssertionIds);
  const support = current.projection.assertions
    .filter((item) =>
      unchangedIds.has(item.id)
      && !appendedIds.has(item.id)
      && continuitySupportEligible(item, current.input.sourceObservedAt)
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const tree = buildContinuityPathTree(
    continuityThreadGraphRef(base.scope),
    support
  );
  if (tree.truncated) {
    return makeResult({
      ...base,
      abstentions: Object.freeze([Object.freeze({
        affectedCount: candidates.length,
        affectedAssertionIds: Object.freeze(candidateIds),
        code: "VISITED_REF_BUDGET_EXCEEDED" as const,
        global: true
      })]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(
        rawDeltaCount,
        candidates.length,
        0,
        1,
        support.length,
        tree.visitedRefs,
        tree.maxDepthReached,
        false
      ),
      status: "abstained"
    });
  }

  const changes: ExplainedContinuityChange[] = [];
  const abstentions: ContinuityChangeAbstention[] = [];
  for (const candidate of candidates) {
    const affected = Object.freeze([
      ...candidate.removals.map((item) => item.id),
      ...candidate.additions.map((item) => item.id)
    ].sort());
    if (candidate.type === "ambiguous") {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "AMBIGUOUS_REVISION",
        global: false
      }));
      continue;
    }
    if (candidate.type === "removal") {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "REMOVAL_TIME_UNKNOWN",
        global: false
      }));
      continue;
    }
    const assertion = candidate.additions[0];
    if (!assertion) continue;
    const basis = classifyContinuityTemporal(
      assertion,
      boundary.observedAt,
      current.input.sourceObservedAt
    );
    if (!basis) {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "OUTSIDE_INTERVAL",
        global: false
      }));
      continue;
    }
    const path = explainContinuityPath(assertion, tree);
    if (!path || path.length > CONTINUITY_CHANGE_LIMITS.maxDepth) {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "NO_PATH_WITHIN_DEPTH",
        global: false
      }));
      continue;
    }
    changes.push(Object.freeze({
      assertion,
      kind: candidate.type === "revision" ? "revised" : "added",
      path,
      ...(candidate.type === "revision"
        ? { replacedAssertionId: candidate.removals[0]?.id }
        : {}),
      temporalBasis: basis
    }));
  }
  changes.sort((a, b) => a.assertion.id.localeCompare(b.assertion.id));
  abstentions.sort((a, b) =>
    a.code.localeCompare(b.code)
    || (a.affectedAssertionIds[0] ?? "").localeCompare(b.affectedAssertionIds[0] ?? "")
  );
  if (changes.length > CONTINUITY_CHANGE_LIMITS.maxExplainedChanges) {
    return makeResult({
      ...base,
      abstentions: Object.freeze([Object.freeze({
        affectedCount: candidates.length,
        affectedAssertionIds: Object.freeze(candidateIds),
        code: "OUTPUT_BUDGET_EXCEEDED" as const,
        global: true
      })]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(
        rawDeltaCount,
        candidates.length,
        0,
        1,
        support.length,
        tree.visitedRefs,
        tree.maxDepthReached,
        false
      ),
      status: "abstained"
    });
  }
  const status = rawDeltaCount === 0
    ? "no-change"
    : statusFor(changes.length, abstentions.length);
  return makeResult({
    ...base,
    abstentions: Object.freeze(abstentions),
    changes: Object.freeze(changes),
    diagnostics: emptyDiagnostics(
      rawDeltaCount,
      candidates.length,
      changes.length,
      abstentions.length,
      support.length,
      tree.visitedRefs,
      tree.maxDepthReached,
      true
    ),
    status
  });
}
