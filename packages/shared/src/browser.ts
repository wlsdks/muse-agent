/** Browser-safe shared utilities. This entry point must stay free of Node-only imports. */
export { errorMessage } from "./error-utils.js";
export {
  isRecord,
  parseJson,
  parseJsonWith,
  type JsonObject,
  type JsonPredicate,
  type JsonPrimitive,
  type JsonValue
} from "./json-utils.js";
export { parseStrictJson, StrictJsonError, type StrictJsonOptions } from "./strict-json.js";
export {
  CANONICAL_RUN_OUTCOMES,
  canonicalRunOutcome,
  decodeLocalRunReference,
  encodeLocalRunReference,
  isCanonicalLocalRunId,
  isCanonicalWorkspaceRealpath,
  type CanonicalRunOutcome,
  type LocalRunReference
} from "./local-run-reference.js";
export {
  decodeLocalCheckpointReference,
  encodeLocalCheckpointReference,
  isCanonicalCheckpointStep,
  type LocalCheckpointReference
} from "./local-checkpoint-reference.js";
export {
  ATTUNEMENT_OUTCOME_FRESHNESS_MS,
  RUN_GROUNDING_FRESHNESS_MS,
  admitDecisionMetric,
  type DecisionMetric,
  type DecisionMetricActionId,
  type DecisionMetricAdmission,
  type DecisionMetricClaim,
  type DecisionMetricEvidenceClass,
  type DecisionMetricExclusionReason,
  type DecisionMetricFreshnessStatus,
  type DecisionMetricInput,
  type DecisionMetricSource,
  type DecisionMetricUnit
} from "./decision-metric.js";
export {
  PERSONAL_STATUS_MAX_CARDS,
  PERSONAL_STATUS_MAX_CARDS_PER_SOURCE,
  PERSONAL_STATUS_SCHEMA_VERSION,
  admitPersonalStatus,
  buildPersonalStatus,
  comparePersonalStatusCards,
  type PersonalStatusAction,
  type PersonalStatusActionId,
  type PersonalStatusActionTarget,
  type PersonalStatusAdmission,
  type PersonalStatusCard,
  type PersonalStatusCardKind,
  type PersonalStatusCardStatus,
  type PersonalStatusOverall,
  type PersonalStatusResponse,
  type PersonalStatusSource,
  type PersonalStatusSourceErrorCode,
  type PersonalStatusSourceId,
  type PersonalStatusSourceResult
} from "./personal-status.js";
