import type {
  ContinuityProjectionScope
} from "./continuity-projection.js";
import type {
  GraphAssertion,
  GraphDirection,
  GraphEvidenceRef,
  GraphRef
} from "./types.js";

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
