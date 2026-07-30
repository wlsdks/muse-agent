export const GRAPH_NODE_KINDS = Object.freeze([
  "thread",
  "artifact",
  "evidence",
  "delivery",
  "outcome",
  "policy",
  "decision",
  "action"
] as const);

export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export const GRAPH_PREDICATES = Object.freeze([
  "LINKED_TO",
  "NEXT_STEP_FOR",
  "CONTEXT_FOR",
  "SUPPORTED_BY",
  "DERIVED_FROM",
  "REVISION_OF",
  "SUPERSEDES",
  "OBSERVED_DURING",
  "DELIVERED_FOR",
  "PRODUCED_OUTCOME",
  "PROPOSES_POLICY",
  "SCOPED_TO",
  "GOVERNED_BY",
  "PRECEDED",
  "CORRELATES_WITH",
  "AUTHORIZED_BY",
  "PERFORMED"
] as const);

export type GraphPredicate = (typeof GRAPH_PREDICATES)[number];

export const GRAPH_EPISTEMIC_CLASSES = Object.freeze([
  "user-asserted",
  "source-observed",
  "deterministic-derived",
  "model-hypothesis"
] as const);

export type GraphEpistemicClass = (typeof GRAPH_EPISTEMIC_CLASSES)[number];

export const GRAPH_DERIVATION_KINDS = Object.freeze([
  "projection",
  "rule",
  "model"
] as const);
export type GraphDerivationKind = (typeof GRAPH_DERIVATION_KINDS)[number];

export interface GraphRef {
  readonly id: string;
  readonly kind: GraphNodeKind;
}

/**
 * Exact reference into an authoritative source or immutable receipt namespace.
 * The graph does not interpret or own the referenced bytes.
 */
export interface GraphEvidenceRef {
  readonly id: string;
  readonly namespace: string;
  readonly version?: string;
}

export interface GraphDerivation {
  readonly kind: GraphDerivationKind;
  readonly runId?: string;
  readonly version: string;
}

export interface GraphAssertion {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly subject: GraphRef;
  readonly predicate: GraphPredicate;
  readonly object: GraphRef;
  readonly epistemicClass: GraphEpistemicClass;
  readonly sourceRefs: readonly GraphEvidenceRef[];
  /** When the assertion became true in the user's world. */
  readonly validFrom?: string;
  /** Exclusive instant at which the assertion stopped being true. */
  readonly validTo?: string;
  /** When the host recorded the assertion. */
  readonly recordedAt: string;
  /** When the host replaced this assertion in transaction history. */
  readonly supersededAt?: string;
  readonly derivation: GraphDerivation;
}

export interface GraphAppendReceipt {
  readonly appended: number;
  readonly assertionIds: readonly string[];
  readonly replayed: number;
}

export const GRAPH_DIRECTIONS = Object.freeze(["outgoing", "incoming", "both"] as const);
export type GraphDirection = (typeof GRAPH_DIRECTIONS)[number];

export interface GraphQueryPlan {
  readonly seeds: readonly GraphRef[];
  readonly predicates: readonly GraphPredicate[];
  readonly direction: GraphDirection;
  readonly maxDepth: number;
  readonly maxAssertions: number;
  readonly maxConsideredAssertions: number;
  readonly maxVisitedRefs: number;
  readonly validAt?: string;
  readonly recordedAtOrBefore?: string;
  readonly epistemicClasses?: readonly GraphEpistemicClass[];
  readonly includeSuperseded?: boolean;
}

export interface GraphTraversalDiagnostics {
  readonly consideredAssertions: number;
  readonly maxDepthReached: number;
  readonly visitedRefs: number;
}

export interface GraphTraversalResult {
  readonly assertions: readonly GraphAssertion[];
  readonly diagnostics: GraphTraversalDiagnostics;
  readonly refs: readonly GraphRef[];
  readonly truncated: boolean;
}

export interface GraphRecordedRange {
  readonly after?: string;
  readonly through?: string;
  readonly limit: number;
}

export interface GraphForgetScope {
  readonly assertionIds?: readonly string[];
  readonly graphRefs?: readonly GraphRef[];
  readonly sourceRefs?: readonly GraphEvidenceRef[];
}

export interface GraphForgetReceipt {
  readonly removed: number;
  readonly removedAssertionIds: readonly string[];
}

export interface GraphVerification {
  readonly assertionCount: number;
  readonly issues: readonly string[];
  readonly ok: boolean;
  readonly sourceReferenceCount: number;
}

export interface AttuneGraphDataStore {
  append(assertions: readonly GraphAssertion[]): Promise<GraphAppendReceipt>;
  forget(scope: GraphForgetScope): Promise<GraphForgetReceipt>;
  getAssertion(id: string): Promise<GraphAssertion | undefined>;
  journal(): Promise<readonly GraphAssertion[]>;
  recorded(range: GraphRecordedRange): Promise<readonly GraphAssertion[]>;
  traverse(plan: GraphQueryPlan): Promise<GraphTraversalResult>;
  verify(): Promise<GraphVerification>;
}

export interface ActivationSubgraphBudget {
  readonly maxAssertions: number;
  readonly maxConsideredAssertions: number;
  readonly maxDepth: number;
  readonly maxEstimatedTokens: number;
  readonly maxVisitedRefs: number;
}

export interface ActivationConflict {
  readonly assertionIds: readonly string[];
  readonly objectRefs: readonly GraphRef[];
  readonly predicate: GraphPredicate;
  readonly sourceRefs: readonly GraphEvidenceRef[];
  readonly subject: GraphRef;
}

export interface ActivationSubgraphDiagnostics {
  readonly candidateAssertions: number;
  readonly detectedConflicts: number;
  readonly estimatedTokens: number;
  readonly maxDepthReached: number;
  readonly reportedConflicts: number;
  readonly selectedAssertions: number;
  readonly truncationReasons: readonly (
    | "assertion-budget"
    | "token-budget"
    | "traversal-budget"
  )[];
  readonly visitedRefs: number;
}

export interface ActivationSubgraph {
  readonly schemaVersion: 1;
  readonly assertions: readonly GraphAssertion[];
  readonly compiledAt: string;
  readonly conflicts: readonly ActivationConflict[];
  readonly diagnostics: ActivationSubgraphDiagnostics;
  readonly refs: readonly GraphRef[];
  readonly seed: GraphRef;
  readonly sourceRefs: readonly GraphEvidenceRef[];
  readonly truncated: boolean;
}

export interface CompileActivationSubgraphInput {
  readonly budget: ActivationSubgraphBudget;
  readonly now: string;
  readonly recordedAtOrBefore?: string;
  readonly seed: GraphRef;
}
