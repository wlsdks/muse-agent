import {
  comparePreparedContinuityObservations,
  type PreparedContinuityComparisonObservation
} from "./continuity-change-comparison.js";
import type {
  ContinuityChangeBoundary,
  ExplainedContinuityChangeResult
} from "./continuity-change-contracts.js";
import {
  CONTINUITY_CHANGE_LIMITS,
  continuityCanonicalInstant,
  continuityDataObject,
  continuityDataString,
  inspectContinuityData,
  parseContinuityProjectionScope,
  queryError
} from "./continuity-change-primitives.js";
import {
  prepareContinuitySourceObservation,
  type PreparedContinuitySourceObservation
} from "./continuity-source-observation.js";
import type {
  GraphEvidenceRef
} from "./types.js";

export {
  CONTINUITY_CHANGE_QUERY_VERSION,
  CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE
} from "./continuity-change-contracts.js";
export type {
  ContinuityChangeAbstention,
  ContinuityChangeAbstentionCode,
  ContinuityChangeBoundary,
  ContinuityChangeDiagnostics,
  ContinuityChangeKind,
  ContinuityChangeObservationDiagnostics,
  ContinuityChangeObservationRef,
  ContinuityChangePathStep,
  ContinuityChangeStatus,
  ContinuityChangeTemporalBasis,
  ExplainedContinuityChange,
  ExplainedContinuityChangeResult
} from "./continuity-change-contracts.js";
export {
  CONTINUITY_CHANGE_LIMITS,
  ContinuityChangeQueryError
} from "./continuity-change-primitives.js";
export type {
  ContinuityChangeQueryErrorCode
} from "./continuity-change-primitives.js";

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

function comparisonObservation(
  prepared: PreparedContinuitySourceObservation
): PreparedContinuityComparisonObservation {
  return Object.freeze({
    get diagnostics() {
      return prepared.diagnostics;
    },
    get projection() {
      return prepared.projection;
    },
    scope: prepared.input.scope,
    sourceObservedAt: prepared.input.sourceObservedAt
  });
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
  return comparePreparedContinuityObservations(
    comparisonObservation(previous),
    comparisonObservation(current),
    boundary
  );
}
