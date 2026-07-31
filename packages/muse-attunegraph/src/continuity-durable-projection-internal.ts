import path from "node:path";
import { types as nodeTypes } from "node:util";

import type {
  AttuneGraph,
  AttuneGraphSnapshot
} from "@attunegraph/core";
import { openLocalAttuneGraph } from "@attunegraph/core/local";

import {
  ContinuityObservationError,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import { continuityThreadGraphRef } from "./continuity-projection.js";

export type ContinuityAttuneGraphProjectionErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_OBSERVATION"
  | "PROJECTION_FAILED";

const ERROR_MESSAGES: Readonly<
  Record<ContinuityAttuneGraphProjectionErrorCode, string>
> = Object.freeze({
  INVALID_CONFIGURATION: "Continuity AttuneGraph projection configuration is invalid",
  INVALID_OBSERVATION: "Continuity Graph Observation Receipt is invalid",
  PROJECTION_FAILED: "Continuity AttuneGraph projection failed"
});

export class ContinuityAttuneGraphProjectionError extends Error {
  readonly code: ContinuityAttuneGraphProjectionErrorCode;

  constructor(
    code: ContinuityAttuneGraphProjectionErrorCode,
    options: Readonly<{ readonly cause?: unknown }> = {}
  ) {
    super(ERROR_MESSAGES[code], options.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "ContinuityAttuneGraphProjectionError";
    this.code = code;
  }
}

export interface ContinuityAttuneGraphProjectorOptions {
  /**
   * Explicit absolute local Store path. There is deliberately no default until
   * AttuneGraph portable export/rebuild clears the default-persistence gate.
   */
  readonly databasePath: string;
}

export interface ContinuityAttuneGraphProjectionResult {
  readonly schemaVersion: 1;
  readonly status: "projected" | "replayed";
  readonly observationReceiptId: string;
  readonly sourceFreshness: Readonly<{
    readonly state: "unknown";
    readonly observedAt: string;
  }>;
  readonly snapshot: AttuneGraphSnapshot;
}

export interface ContinuityAttuneGraphProjector {
  /**
   * Calls are serialized in invocation order. An external-writer race remains
   * fail-closed through the Engine's atomic expected-snapshot CAS.
   */
  project(
    observationReceipt: unknown
  ): Promise<ContinuityAttuneGraphProjectionResult>;
}

type ProjectionAttuneGraph = Pick<
  AttuneGraph,
  "close" | "head" | "project"
>;

export interface ContinuityAttuneGraphProjectorDependencies {
  readonly openLocal: (
    options: Readonly<{
      readonly databasePath: string;
      readonly scope: Readonly<{
        readonly sourceId: string;
        readonly threadId: string;
      }>;
    }>
  ) => Promise<ProjectionAttuneGraph>;
}

function dataRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[]
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new ContinuityAttuneGraphProjectionError("INVALID_CONFIGURATION");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ContinuityAttuneGraphProjectionError("INVALID_CONFIGURATION");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) {
    throw new ContinuityAttuneGraphProjectionError("INVALID_CONFIGURATION");
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ContinuityAttuneGraphProjectionError("INVALID_CONFIGURATION");
    }
    output[key as string] = descriptor.value;
  }
  return Object.freeze(output);
}

function normalizeOptions(
  input: unknown
): ContinuityAttuneGraphProjectorOptions {
  const options = dataRecord(
    input,
    ["databasePath"],
    ["databasePath"]
  );
  const databasePath = options.databasePath;
  if (
    typeof databasePath !== "string"
    || databasePath.length === 0
    || databasePath.includes("\0")
    || databasePath.trim() !== databasePath
    || !path.isAbsolute(databasePath)
    || path.normalize(databasePath) !== databasePath
  ) {
    throw new ContinuityAttuneGraphProjectionError("INVALID_CONFIGURATION");
  }
  return Object.freeze({ databasePath });
}

function sameSnapshot(
  left: AttuneGraphSnapshot | undefined,
  right: AttuneGraphSnapshot
): boolean {
  return left !== undefined
    && left.generation === right.generation
    && left.commitId === right.commitId
    && left.scope.sourceId === right.scope.sourceId
    && left.scope.threadId === right.scope.threadId;
}

function invalidObservation(cause: unknown): ContinuityAttuneGraphProjectionError {
  return new ContinuityAttuneGraphProjectionError(
    "INVALID_OBSERVATION",
    { cause }
  );
}

function projectionFailure(cause: unknown): ContinuityAttuneGraphProjectionError {
  return cause instanceof ContinuityAttuneGraphProjectionError
    ? cause
    : new ContinuityAttuneGraphProjectionError(
        "PROJECTION_FAILED",
        { cause }
      );
}

async function projectOne(
  databasePath: string,
  receipt: ContinuityObservationReceipt,
  dependencies: ContinuityAttuneGraphProjectorDependencies
): Promise<ContinuityAttuneGraphProjectionResult> {
  const scope = receipt.projection.scope;
  const detachedScope = {
    sourceId: scope.sourceId,
    threadId: scope.threadId
  };
  const detachedAssertions = structuredClone(
    receipt.projection.assertions
  );
  const detachedThreadRoot = structuredClone(
    continuityThreadGraphRef(scope)
  );
  let graph: ProjectionAttuneGraph;
  try {
    graph = await dependencies.openLocal({
      databasePath,
      scope: detachedScope
    });
  } catch (cause) {
    throw projectionFailure(cause);
  }

  let primaryFailure: unknown;
  let result: ContinuityAttuneGraphProjectionResult | undefined;
  try {
    const expectedSnapshot = await graph.head();
    const snapshot = await graph.project({
      operator: "canonical-projection@2",
      ...(expectedSnapshot === undefined ? {} : { expectedSnapshot }),
      observation: {
        schemaVersion: 2,
        observationKey: receipt.receiptId,
        scope: detachedScope,
        threadRoot: detachedThreadRoot,
        observedAt: receipt.observedAt,
        sourceFreshness: {
          state: "unknown",
          observedAt: receipt.observedAt
        },
        assertions: detachedAssertions
      }
    });
    result = Object.freeze({
      schemaVersion: 1 as const,
      status: sameSnapshot(expectedSnapshot, snapshot)
        ? "replayed" as const
        : "projected" as const,
      observationReceiptId: receipt.receiptId,
      sourceFreshness: Object.freeze({
        state: "unknown" as const,
        observedAt: receipt.observedAt
      }),
      snapshot
    });
  } catch (cause) {
    primaryFailure = cause;
  }

  try {
    await graph.close();
  } catch (cause) {
    primaryFailure ??= cause;
  }

  if (primaryFailure !== undefined) {
    throw projectionFailure(primaryFailure);
  }
  return result!;
}

export function createContinuityAttuneGraphProjectorWithDependencies(
  rawOptions: ContinuityAttuneGraphProjectorOptions,
  dependencies: ContinuityAttuneGraphProjectorDependencies
): ContinuityAttuneGraphProjector {
  const options = normalizeOptions(rawOptions);
  let tail: Promise<void> = Promise.resolve();

  return Object.freeze({
    project(
      observationReceipt: unknown
    ): Promise<ContinuityAttuneGraphProjectionResult> {
      let receipt: ContinuityObservationReceipt;
      try {
        receipt = verifyContinuityObservation(observationReceipt);
      } catch (cause) {
        return Promise.reject(
          invalidObservation(
            cause instanceof ContinuityObservationError ? cause : undefined
          )
        );
      }
      const operation = tail.then(() =>
        projectOne(options.databasePath, receipt, dependencies)
      );
      tail = operation.then(
        () => undefined,
        () => undefined
      );
      return operation;
    }
  });
}

export function createContinuityAttuneGraphProjector(
  options: ContinuityAttuneGraphProjectorOptions
): ContinuityAttuneGraphProjector {
  return createContinuityAttuneGraphProjectorWithDependencies(options, {
    openLocal: openLocalAttuneGraph
  });
}
