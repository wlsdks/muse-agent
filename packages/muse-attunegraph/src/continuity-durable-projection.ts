/**
 * Muse-specific durable projection into the embedded AttuneGraph Store.
 *
 * The Module accepts only a verified Continuity Graph Observation Receipt,
 * preserves its exact assertions and scope, and never upgrades its
 * caller-declared observation into freshness or source authority.
 */
export {
  ContinuityAttuneGraphProjectionError,
  createContinuityAttuneGraphProjector,
  createContinuityAttuneGraphSessionProjector
} from "./continuity-durable-projection-internal.js";

export type {
  ContinuityAttuneGraphProjectionErrorCode,
  ContinuityAttuneGraphProjectionResult,
  ContinuityAttuneGraphProjector,
  ContinuityAttuneGraphProjectorOptions,
  ContinuityAttuneGraphSessionProjector
} from "./continuity-durable-projection-internal.js";
