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
