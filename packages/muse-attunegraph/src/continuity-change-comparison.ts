import { createHash } from "node:crypto";

import {
  CONTINUITY_CHANGE_QUERY_VERSION,
  CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
  type ContinuityChangeAbstention,
  type ContinuityChangeBoundary,
  type ContinuityChangeDiagnostics,
  type ContinuityChangeObservationDiagnostics,
  type ContinuityChangeObservationRef,
  type ContinuityChangeStatus,
  type ExplainedContinuityChange,
  type ExplainedContinuityChangeResult
} from "./continuity-change-contracts.js";
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
import { queryError } from "./continuity-change-primitives.js";
import {
  continuityThreadGraphRef,
  diffContinuityProjections,
  type ContinuityGraphProjection,
  type ContinuityProjectionScope
} from "./continuity-projection.js";
import type {
  GraphAssertion,
  GraphEvidenceRef
} from "@attunegraph/core";
import { evidenceRefKey } from "@attunegraph/core/extension-kit";

export interface PreparedContinuityComparisonObservation {
  readonly diagnostics: ContinuityChangeObservationDiagnostics;
  readonly projection: ContinuityGraphProjection;
  readonly scope: ContinuityProjectionScope;
  readonly sourceObservedAt: string;
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
  sourceObservedAt: string,
  projection: ContinuityGraphProjection
): ContinuityChangeObservationRef {
  return Object.freeze({
    projectionVersion: projection.projectionVersion,
    sourceObservedAt,
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

export function comparePreparedContinuityObservations(
  previous: PreparedContinuityComparisonObservation,
  current: PreparedContinuityComparisonObservation,
  boundary: ContinuityChangeBoundary
): ExplainedContinuityChangeResult {
  if (
    !sameContinuityScope(previous.scope, current.scope)
    || !sameContinuityScope(previous.scope, boundary.scope)
  ) {
    queryError("INVALID_INPUT", "previous, current, and boundary scopes must match");
  }
  if (
    previous.sourceObservedAt !== boundary.observedAt
    || instant(current.sourceObservedAt) < instant(boundary.observedAt)
  ) {
    queryError("INVALID_INPUT", "boundary observation interval is invalid");
  }

  const previousProjection = previous.projection;
  const expectedBoundaryRef: GraphEvidenceRef = {
    id: previousProjection.sourceVersion,
    namespace: CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
    version: previousProjection.projectionVersion
  };
  if (evidenceRefKey(boundary.sourceRef) !== evidenceRefKey(expectedBoundaryRef)) {
    queryError("INVALID_INPUT", "boundary source ref does not bind the previous projection");
  }

  const currentProjection = current.projection;
  const base = {
    boundary,
    current: observationRef(current.sourceObservedAt, currentProjection),
    previous: observationRef(previous.sourceObservedAt, previousProjection),
    queryVersion: CONTINUITY_CHANGE_QUERY_VERSION,
    schemaVersion: 1 as const,
    scope: previousProjection.scope
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
      previousProjection.assertions.length + currentProjection.assertions.length,
    embeddingCalls: 0 as const,
    maxDepthReached,
    modelCalls: 0 as const,
    previous: previous.diagnostics,
    rawDeltaCount,
    visitedRefs
  });

  const inconsistent = [
    ...previousProjection.assertions
      .filter((item) =>
        instant(item.recordedAt) > instant(previous.sourceObservedAt)
      ),
    ...currentProjection.assertions
      .filter((item) =>
        instant(item.recordedAt) > instant(current.sourceObservedAt)
      )
  ].map((item) => item.id).sort();

  if (isContinuityNoOp(previousProjection, currentProjection)) {
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

  const delta = diffContinuityProjections(
    previousProjection,
    currentProjection
  );
  const rawDeltaCount = delta.append.length + delta.forgetAssertionIds.length;
  if (rawDeltaCount > CONTINUITY_CHANGE_LIMITS.maxRawDelta) {
    queryError("RAW_DELTA_BUDGET_EXCEEDED", "raw delta exceeds query budget", {
      limit: CONTINUITY_CHANGE_LIMITS.maxRawDelta,
      rawDeltaCount
    });
  }
  const previousById = new Map(
    previousProjection.assertions.map((item) => [item.id, item])
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
  const support = currentProjection.assertions
    .filter((item) =>
      unchangedIds.has(item.id)
      && !appendedIds.has(item.id)
      && continuitySupportEligible(item, current.sourceObservedAt)
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
      current.sourceObservedAt
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
