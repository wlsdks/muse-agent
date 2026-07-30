import {
  comparePreparedContinuityObservations,
  type PreparedContinuityComparisonObservation
} from "./continuity-change-comparison.js";
import {
  CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
  type ContinuityChangeBoundary,
  type ExplainedContinuityChangeResult
} from "./continuity-change-contracts.js";

import type { ContinuityObservationReceipt } from "./continuity-observation.js";

export function preparedContinuityReceiptObservation(
  receipt: ContinuityObservationReceipt
): PreparedContinuityComparisonObservation {
  return Object.freeze({
    diagnostics: receipt.diagnostics,
    projection: receipt.projection,
    scope: receipt.projection.scope,
    sourceObservedAt: receipt.observedAt
  });
}

export function continuityReceiptComparisonBoundary(
  receipt: ContinuityObservationReceipt
): ContinuityChangeBoundary {
  return Object.freeze({
    authority: "caller-declared-observation",
    observedAt: receipt.observedAt,
    schemaVersion: 1,
    scope: receipt.projection.scope,
    sourceRef: Object.freeze({
      id: receipt.projection.sourceVersion,
      namespace: CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
      version: receipt.projection.projectionVersion
    })
  });
}

/** Compare receipts only after their public verifier has canonicalized both values. */
export function compareVerifiedContinuityObservationReceipts(
  previous: ContinuityObservationReceipt,
  current: ContinuityObservationReceipt
): ExplainedContinuityChangeResult {
  return comparePreparedContinuityObservations(
    preparedContinuityReceiptObservation(previous),
    preparedContinuityReceiptObservation(current),
    continuityReceiptComparisonBoundary(previous)
  );
}
