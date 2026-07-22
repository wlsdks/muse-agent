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
