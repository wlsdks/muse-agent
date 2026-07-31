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
} from "./json-data.js";
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
  type DecisionMetricDataOrigin,
  type DecisionMetricExecutionEvidence,
  type DecisionMetricExclusionReason,
  type DecisionMetricFreshnessStatus,
  type DecisionMetricInput,
  type DecisionMetricSource,
  type DecisionMetricUnit
} from "./decision-metric.js";
export {
  DELIVERY_SAFETY_FAILED_REASON_CODES,
  DELIVERY_SAFETY_REASON,
  DELIVERY_SAFETY_REASON_CODES,
  DELIVERY_SAFETY_SCHEMA_VERSION,
  isDeliverySafetyResult,
  type DeliverySafetyBooleanObservation,
  type DeliverySafetyBrakeObservation,
  type DeliverySafetyCountObservation,
  type DeliverySafetyEvidence,
  type DeliverySafetyHoldObservation,
  type DeliverySafetyObservation,
  type DeliverySafetyReasonCode,
  type DeliverySafetyResult,
  type DeliverySafetyStatus,
  type PendingDraftCountObservation
} from "./delivery-safety-contract.js";
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
