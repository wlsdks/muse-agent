export {
  ACTIVATION_PREDICATES,
  GRAPH_ASSERTION_SOURCE_NAMESPACE,
  MAX_ACTIVATION_ESTIMATED_TOKENS,
  MAX_GRAPH_APPEND_BATCH_ASSERTIONS,
  MAX_GRAPH_ASSERTION_SOURCE_REFS,
  MAX_GRAPH_QUERY_ASSERTIONS,
  MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS,
  MAX_GRAPH_QUERY_DEPTH,
  MAX_GRAPH_QUERY_SEEDS,
  MAX_GRAPH_QUERY_VISITED_REFS
} from "./constants.js";
export { AttuneGraphDataError, type AttuneGraphDataErrorCode } from "./error.js";
export { AttuneGraphError, type AttuneGraphErrorCode } from "./attunegraph-error.js";
export { createAttuneGraphEngine, openAttuneGraph } from "./attunegraph-engine.js";
export type {
  AttuneGraph,
  AttuneGraphExecuteCommand,
  AttuneGraphOperatorResult,
  AttuneGraphProjectCommand,
  AttuneGraphScope,
  AttuneGraphSnapshot,
  AttuneGraphSourceAdapter,
  AttuneGraphSourceFreshness,
  AttuneGraphSourceObservation,
  AttuneGraphStore,
  AttuneGraphWorkingGraph,
  OpenAttuneGraphOptions
} from "./attunegraph-contracts.js";
export { compileActivationSubgraph } from "./activation-subgraph.js";
export { InMemoryAttuneGraphDataStore } from "./in-memory-store.js";
export {
  GRAPH_DERIVATION_KINDS,
  GRAPH_DIRECTIONS,
  GRAPH_EPISTEMIC_CLASSES,
  GRAPH_NODE_KINDS,
  GRAPH_PREDICATES,
  type ActivationConflict,
  type ActivationSubgraph,
  type ActivationSubgraphBudget,
  type ActivationSubgraphDiagnostics,
  type AttuneGraphDataStore,
  type CompileActivationSubgraphInput,
  type GraphAppendReceipt,
  type GraphAssertion,
  type GraphDerivation,
  type GraphDerivationKind,
  type GraphDirection,
  type GraphEpistemicClass,
  type GraphEvidenceRef,
  type GraphForgetReceipt,
  type GraphForgetScope,
  type GraphNodeKind,
  type GraphPredicate,
  type GraphQueryPlan,
  type GraphRecordedRange,
  type GraphRef,
  type GraphTraversalDiagnostics,
  type GraphTraversalResult,
  type GraphVerification
} from "./types.js";
