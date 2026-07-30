import {
  createContinuityAttuneGraphProjector,
  type ContinuityAttuneGraphProjector
} from "@muse/attunegraph/continuity-durable-projection";

import type { MuseEnvironment } from "./runtime-assembly.js";

/**
 * Explicit opt-in only. An absent or exactly empty setting is disabled;
 * every non-empty value is validated by the projector and fails assembly
 * creation closed when invalid.
 */
export function createConfiguredContinuityAttuneGraphProjector(
  env: MuseEnvironment
): ContinuityAttuneGraphProjector | undefined {
  const databasePath = env.MUSE_ATTUNEGRAPH_DATABASE;
  return databasePath === undefined || databasePath === ""
    ? undefined
    : createContinuityAttuneGraphProjector({ databasePath });
}
