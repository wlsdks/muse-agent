import { types as nodeTypes } from "node:util";

import {
  createContinuityAttuneGraphProjector,
  type ContinuityAttuneGraphProjectionResult,
  type ContinuityAttuneGraphProjector
} from "@muse/attunegraph/continuity-durable-projection";
import {
  captureContinuityObservation
} from "@muse/attunegraph/continuity-observations";
import {
  captureContinuityShadowReturnObservation
} from "@muse/attunegraph/continuity-shadow-returns";
import {
  readAttunementState,
  readTimingState
} from "@muse/attunement";

import type { MuseEnvironment } from "./runtime-assembly.js";
import { resolveAttunementFile } from "./personal-providers.js";

export const continuityRuntimeSourceId =
  "muse.local-attunement" as const;

export interface ProjectConfiguredContinuityAttuneGraphInput {
  readonly sourceObservedAt: string;
  readonly threadId: string;
}

function normalizeCurrentStateInput(
  value: unknown
): ProjectConfiguredContinuityAttuneGraphInput {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new TypeError(
      "configured Continuity AttuneGraph input must be a plain object"
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      "configured Continuity AttuneGraph input must be a plain object"
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const required = ["sourceObservedAt", "threadId"] as const;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== required.length
    || keys.some((key) =>
      typeof key !== "string"
      || !required.includes(key as (typeof required)[number])
      || descriptors[key] === undefined
      || !("value" in descriptors[key]!)
    )
    || required.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    throw new TypeError(
      "configured Continuity AttuneGraph input has invalid fields"
    );
  }
  const sourceObservedAt = descriptors.sourceObservedAt!.value;
  const threadId = descriptors.threadId!.value;
  if (
    typeof sourceObservedAt !== "string"
    || typeof threadId !== "string"
  ) {
    throw new TypeError(
      "configured Continuity AttuneGraph input fields must be strings"
    );
  }
  return Object.freeze({ sourceObservedAt, threadId });
}

/**
 * Explicit opt-in only. An absent or exactly empty setting is disabled;
 * every non-empty value is validated by the projector and fails assembly
 * creation closed when invalid.
 */
export function createConfiguredContinuityAttuneGraphProjector(
  env: MuseEnvironment
): ContinuityAttuneGraphProjector | undefined {
  const databasePath = env.MUSE_ATTUNEGRAPH_DATABASE;
  if (databasePath === undefined || databasePath === "") return undefined;
  const projector = createContinuityAttuneGraphProjector({ databasePath });
  const attunementFile = resolveAttunementFile(env);
  return Object.freeze({
    async project(observationReceipt: unknown) {
      const [state, timingState] = await Promise.all([
        readAttunementState(attunementFile),
        readTimingState(`${attunementFile}.timing.json`)
      ]);
      return projector.project(
        captureContinuityShadowReturnObservation({
          baseObservationReceipt: observationReceipt,
          state,
          timingState
        })
      );
    }
  });
}

/**
 * Rebuilds the configured composite scope from current local source ledgers.
 * Disabled configuration is a no-op; configured failures are surfaced to the
 * caller so product paths can preserve their primary operation separately.
 */
export async function projectConfiguredContinuityAttuneGraphCurrentState(
  env: MuseEnvironment,
  input: ProjectConfiguredContinuityAttuneGraphInput
): Promise<ContinuityAttuneGraphProjectionResult | undefined> {
  const normalized = normalizeCurrentStateInput(input);
  const projector = createConfiguredContinuityAttuneGraphProjector(env);
  if (!projector) return undefined;
  const state = await readAttunementState(resolveAttunementFile(env));
  const observation = captureContinuityObservation({
    scope: {
      sourceId: continuityRuntimeSourceId,
      threadId: normalized.threadId
    },
    sourceObservedAt: normalized.sourceObservedAt,
    state
  });
  return projector.project(observation);
}
