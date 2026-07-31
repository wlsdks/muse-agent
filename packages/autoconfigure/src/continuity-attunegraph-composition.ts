import { types as nodeTypes } from "node:util";

import {
  ContinuityAttuneGraphProjectionError,
  createContinuityAttuneGraphProjector,
  createContinuityAttuneGraphSessionProjector,
  type ContinuityAttuneGraphProjectionResult,
  type ContinuityAttuneGraphProjector,
  type ContinuityAttuneGraphSessionProjector
} from "@muse/attunegraph/continuity-durable-projection";
import {
  captureContinuityObservation
} from "@muse/attunegraph/continuity-observations";
import {
  captureContinuityShadowReturnObservation,
  inspectContinuityShadowReturns,
  type ShadowReturnInspectionReport
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

export interface ReadConfiguredContinuityShadowReturnsInput {
  readonly limit?: number;
  readonly now: string;
  readonly timingFile: string;
}

const SHADOW_RETURN_INSPECTION_MAX_ESTIMATED_TOKENS = 12_000;

function normalizeShadowReturnInspectionInput(
  value: unknown
): Readonly<{ readonly limit: number; readonly now: string; readonly timingFile: string }> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new TypeError("configured Shadow Return inspection input must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("configured Shadow Return inspection input must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const allowed = ["limit", "now", "timingFile"] as const;
  if (
    keys.some((key) =>
      typeof key !== "string"
      || !allowed.includes(key as (typeof allowed)[number])
      || !("value" in descriptors[key]!)
    )
    || !Object.hasOwn(descriptors, "now")
    || !Object.hasOwn(descriptors, "timingFile")
  ) {
    throw new TypeError("configured Shadow Return inspection input has invalid fields");
  }
  const timingFile = descriptors.timingFile!.value;
  const now = descriptors.now!.value;
  const limit = descriptors.limit?.value ?? 20;
  if (
    typeof timingFile !== "string"
    || timingFile.length === 0
    || typeof now !== "string"
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > 20
  ) {
    throw new TypeError("configured Shadow Return inspection input is invalid");
  }
  return Object.freeze({ limit, now, timingFile });
}

/**
 * Reads one capability-authenticated timing snapshot, then inspects that exact
 * frozen snapshot. This is intentionally read-only and never accepts a
 * caller-provided receipt or timing-state structure.
 */
export async function readConfiguredContinuityShadowReturns(
  env: MuseEnvironment,
  input: ReadConfiguredContinuityShadowReturnsInput
): Promise<ShadowReturnInspectionReport> {
  const normalized = normalizeShadowReturnInspectionInput(input);
  const timingState = await readTimingState(normalized.timingFile);
  return inspectContinuityShadowReturns({
    databasePath: env.MUSE_ATTUNEGRAPH_DATABASE,
    limit: normalized.limit,
    maxEstimatedTokens: SHADOW_RETURN_INSPECTION_MAX_ESTIMATED_TOKENS,
    now: normalized.now,
    timingState
  });
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
    project: (observationReceipt: unknown) =>
      projectConfiguredObservation(
        projector,
        attunementFile,
        observationReceipt
      )
  });
}

async function projectConfiguredObservation(
  projector: ContinuityAttuneGraphProjector,
  attunementFile: string,
  observationReceipt: unknown
): Promise<ContinuityAttuneGraphProjectionResult> {
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

export function createConfiguredContinuityAttuneGraphSessionProjector(
  env: MuseEnvironment
): ContinuityAttuneGraphSessionProjector | undefined {
  const databasePath = env.MUSE_ATTUNEGRAPH_DATABASE;
  if (databasePath === undefined || databasePath === "") return undefined;
  const projector = createContinuityAttuneGraphSessionProjector({ databasePath });
  const attunementFile = resolveAttunementFile(env);
  let lifecycle: "open" | "closing" | "closed" = "open";
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  return Object.freeze({
    project(observationReceipt: unknown) {
      if (lifecycle !== "open") {
        return Promise.reject(
          new ContinuityAttuneGraphProjectionError("CLOSED")
        );
      }
      const operation = tail.then(() =>
        projectConfiguredObservation(
          projector,
          attunementFile,
          observationReceipt
        )
      );
      tail = operation.then(
        () => undefined,
        () => undefined
      );
      return operation;
    },
    close() {
      if (closePromise) return closePromise;
      lifecycle = "closing";
      closePromise = tail
        .then(() => projector.close())
        .finally(() => {
          lifecycle = "closed";
        });
      return closePromise;
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
