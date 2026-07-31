import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  verifyPersistedTimingState,
  type AttuneGraphShadowReturnReceipt
} from "@muse/attunement";
import type {
  AttuneGraphOperatorResult,
  GraphAssertion,
  GraphEvidenceRef,
  GraphRef
} from "@attunegraph/core";
import { openLocalAttuneGraph } from "@attunegraph/core/local";
import {
  evidenceRefKey,
  graphRefKey,
  normalizeGraphAssertion,
  normalizeGraphAssertionBatch
} from "@attunegraph/core/extension-kit";

import { CONTINUITY_CHANGE_LIMITS } from "./continuity-change-semantics.js";
import { inspectContinuityData } from "./continuity-change-primitives.js";
import {
  captureContinuityObservation,
  sealContinuityObservation,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  CONTINUITY_PROJECTION_RULE_VERSION,
  continuityShadowReturnProjectionRuleVersion,
  type ContinuityGraphProjection
} from "./continuity-projection.js";
import {
  deriveContinuityDeliveryGraphRef,
  deriveContinuityShadowDecisionGraphRef,
  deriveContinuityShadowReturnEvidenceGraphRef,
  deriveContinuityShadowReturnSourceRef,
  deriveContinuityThreadGraphRef
} from "./continuity-projection-identity.js";

export const continuityCompositeSourceId =
  "muse.local-attunement-timing" as const;

export type ContinuityShadowReturnObservationErrorCode =
  | "BUDGET_EXCEEDED"
  | "DELIVERY_MISMATCH"
  | "INVALID_BASE_OBSERVATION"
  | "INVALID_INPUT"
  | "SOURCE_MISMATCH";

export class ContinuityShadowReturnObservationError extends Error {
  readonly code: ContinuityShadowReturnObservationErrorCode;

  constructor(
    code: ContinuityShadowReturnObservationErrorCode,
    message: string,
    options: Readonly<{ readonly cause?: unknown }> = {}
  ) {
    super(message, options.cause === undefined
      ? undefined
      : { cause: options.cause });
    this.name = "ContinuityShadowReturnObservationError";
    this.code = code;
  }
}

export interface CaptureContinuityShadowReturnObservationInput {
  /** Provider/source-revalidated v1 observation. It remains unchanged. */
  readonly baseObservationReceipt: unknown;
  /** Exact Attunement state used to rebuild the reserved composite scope. */
  readonly state: unknown;
  /** Capability returned by readTimingState; lookalike objects are refused. */
  readonly timingState: unknown;
}

export interface ReadContinuityShadowReturnWorkingGraphOptions {
  readonly databasePath: string;
  readonly maxEstimatedTokens: number;
  readonly now: string;
  readonly threadId: string;
}

interface AssertionInput {
  readonly object: GraphRef;
  readonly predicate: "OBSERVED_DURING" | "PRECEDED";
  readonly recordedAt: string;
  readonly sourceRef: GraphEvidenceRef;
  readonly subject: GraphRef;
  readonly validFrom: string;
}

function fail(
  code: ContinuityShadowReturnObservationErrorCode,
  message: string,
  cause?: unknown
): never {
  throw new ContinuityShadowReturnObservationError(
    code,
    message,
    cause === undefined ? {} : { cause }
  );
}

function exactDataRecord(
  value: unknown,
  allowed: readonly string[],
  label: string
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    fail("INVALID_INPUT", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_INPUT", `${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== allowed.length
    || keys.some((key) =>
      typeof key !== "string"
      || !allowed.includes(key)
      || descriptors[key] === undefined
      || !("value" in descriptors[key]!)
    )
    || allowed.some((key) => !Object.hasOwn(descriptors, key))
  ) {
    fail("INVALID_INPUT", `${label} has invalid fields`);
  }
  return Object.freeze(Object.fromEntries(
    allowed.map((key) => [key, descriptors[key]!.value])
  ));
}

function inputRecord(value: unknown): Readonly<Record<string, unknown>> {
  return exactDataRecord(
    value,
    ["baseObservationReceipt", "state", "timingState"],
    "Shadow-return observation input"
  );
}

function workingGraphOptionsRecord(
  value: unknown
): ReadContinuityShadowReturnWorkingGraphOptions {
  return exactDataRecord(
    value,
    ["databasePath", "maxEstimatedTokens", "now", "threadId"],
    "Shadow-return Working Graph options"
  ) as unknown as ReadContinuityShadowReturnWorkingGraphOptions;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) output[key] = canonicalValue(child);
    }
    return output;
  }
  fail("INVALID_INPUT", "Shadow-return observation contains unsupported data");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function assertionId(body: unknown): string {
  return `muse-continuity-assertion:${digest(body).slice("sha256:".length)}`;
}

function projectionVersion(
  projection: Pick<
    ContinuityGraphProjection,
    "assertions" | "ruleVersion" | "scope"
  >
): string {
  return digest({
    assertions: projection.assertions,
    ruleVersion: projection.ruleVersion,
    scope: projection.scope
  });
}

function sameRef(left: GraphRef, right: GraphRef): boolean {
  return graphRefKey(left) === graphRefKey(right);
}

function makeAssertion(input: AssertionInput): GraphAssertion {
  const body = {
    schemaVersion: 1 as const,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    epistemicClass: "source-observed" as const,
    sourceRefs: Object.freeze([input.sourceRef]),
    validFrom: input.validFrom,
    recordedAt: input.recordedAt,
    derivation: {
      kind: "projection" as const,
      version: continuityShadowReturnProjectionRuleVersion
    }
  };
  return normalizeGraphAssertion({
    ...body,
    id: assertionId(body)
  });
}

function exactDeliveryAssertion(
  projection: ContinuityGraphProjection,
  receipt: AttuneGraphShadowReturnReceipt
): GraphAssertion {
  const threadRef = deriveContinuityThreadGraphRef(
    projection.scope.sourceId,
    projection.scope.threadId
  );
  const deliveryRef = deriveContinuityDeliveryGraphRef(
    projection.scope.sourceId,
    receipt.deliveryId
  );
  const matches = projection.assertions.filter((assertion) =>
    assertion.predicate === "DELIVERED_FOR"
    && sameRef(assertion.subject, deliveryRef)
    && sameRef(assertion.object, threadRef)
  );
  if (
    matches.length !== 1
    || matches[0]!.epistemicClass !== "source-observed"
    || matches[0]!.recordedAt !== receipt.openedAt
    || matches[0]!.validFrom !== receipt.openedAt
  ) {
    fail(
      "DELIVERY_MISMATCH",
      `Shadow return '${receipt.id}' does not bind one exact Continuity Delivery`
    );
  }
  return matches[0]!;
}

function returnAssertions(
  projection: ContinuityGraphProjection,
  receipt: AttuneGraphShadowReturnReceipt
): readonly GraphAssertion[] {
  const sourceId = projection.scope.sourceId;
  const sourceRef = deriveContinuityShadowReturnSourceRef(sourceId, receipt);
  const threadRef = deriveContinuityThreadGraphRef(
    sourceId,
    projection.scope.threadId
  );
  return Object.freeze([
    makeAssertion({
      subject: deriveContinuityShadowDecisionGraphRef(
        sourceId,
        receipt.candidateId
      ),
      predicate: "PRECEDED",
      object: deriveContinuityDeliveryGraphRef(sourceId, receipt.deliveryId),
      recordedAt: receipt.openedAt,
      sourceRef,
      validFrom: receipt.openedAt
    }),
    makeAssertion({
      subject: deriveContinuityShadowReturnEvidenceGraphRef(
        sourceId,
        receipt.id
      ),
      predicate: "OBSERVED_DURING",
      object: threadRef,
      recordedAt: receipt.openedAt,
      sourceRef,
      validFrom: receipt.openedAt
    })
  ]);
}

function addBounded(
  left: number,
  right: number,
  limit: number,
  label: string
): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total > limit) {
    fail("BUDGET_EXCEEDED", `${label} exceeds its projection budget`);
  }
  return total;
}

/**
 * Rebuilds one complete, reserved-scope observation from the two authoritative
 * local ledgers. It never mutates either ledger and never promotes a factual
 * return into feedback, outcome, causality, usefulness, or permission.
 */
export function captureContinuityShadowReturnObservation(
  input: CaptureContinuityShadowReturnObservationInput
): ContinuityObservationReceipt {
  const record = inputRecord(input);
  let base: ContinuityObservationReceipt;
  try {
    base = verifyContinuityObservation(record.baseObservationReceipt);
  } catch (cause) {
    fail(
      "INVALID_BASE_OBSERVATION",
      "base Continuity Observation Receipt is invalid",
      cause
    );
  }
  if (base.projection.ruleVersion !== CONTINUITY_PROJECTION_RULE_VERSION) {
    fail(
      "INVALID_BASE_OBSERVATION",
      "base Continuity Observation Receipt must use the v1 source-only rule"
    );
  }

  let timingState;
  try {
    timingState = verifyPersistedTimingState(record.timingState);
  } catch (cause) {
    fail(
      "INVALID_INPUT",
      "timingState must be the current persisted timing snapshot",
      cause
    );
  }

  let compositeBase: ContinuityObservationReceipt;
  try {
    compositeBase = captureContinuityObservation({
      scope: {
        sourceId: continuityCompositeSourceId,
        threadId: base.projection.scope.threadId
      },
      sourceObservedAt: base.observedAt,
      state: record.state
    });
  } catch (cause) {
    fail("INVALID_INPUT", "Attunement state cannot be projected", cause);
  }
  if (
    compositeBase.projection.sourceVersion
    !== base.projection.sourceVersion
  ) {
    fail(
      "SOURCE_MISMATCH",
      "Attunement state changed after the base observation was captured"
    );
  }

  const returns = timingState.returns
    .filter((receipt) =>
      receipt.threadId === base.projection.scope.threadId
    )
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const appended = returns.flatMap((receipt) => {
    exactDeliveryAssertion(compositeBase.projection, receipt);
    return returnAssertions(compositeBase.projection, receipt);
  });
  const assertions = normalizeGraphAssertionBatch([
    ...compositeBase.projection.assertions,
    ...appended
  ]).slice().sort((left, right) => left.id.localeCompare(right.id));
  if (assertions.length > CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions) {
    fail(
      "BUDGET_EXCEEDED",
      "Shadow-return assertions exceed the Continuity projection budget"
    );
  }

  const timingInspection = inspectContinuityData(
    timingState.returns,
    "persisted timing returns"
  );
  const sourceRefs = new Map<string, GraphEvidenceRef>();
  for (const receipt of returns) {
    const sourceRef = deriveContinuityShadowReturnSourceRef(
      continuityCompositeSourceId,
      receipt
    );
    sourceRefs.set(evidenceRefKey(sourceRef), sourceRef);
  }
  const timestampBasis = [
    ...compositeBase.projection.timestampBasis,
    ...[...sourceRefs.values()].map((sourceRef) =>
      Object.freeze({
        basis: "source-event" as const,
        sourceRef
      })
    )
  ].sort((left, right) =>
    evidenceRefKey(left.sourceRef).localeCompare(
      evidenceRefKey(right.sourceRef)
    )
  );
  const projectionBody = {
    schemaVersion: 1 as const,
    ruleVersion: continuityShadowReturnProjectionRuleVersion,
    scope: compositeBase.projection.scope,
    sourceVersion: digest({
      continuitySourceVersion: compositeBase.projection.sourceVersion,
      shadowReturns: returns
    }),
    assertions: Object.freeze(assertions),
    timestampBasis: Object.freeze(timestampBasis)
  };
  const projection = Object.freeze({
    ...projectionBody,
    projectionVersion: projectionVersion(projectionBody)
  });
  const diagnostics = Object.freeze({
    descriptorsInspected: addBounded(
      compositeBase.diagnostics.descriptorsInspected,
      timingInspection.descriptors,
      CONTINUITY_CHANGE_LIMITS.maxDescriptors,
      "descriptor accounting"
    ),
    projectedAssertions: assertions.length,
    sourceRecordsInspected: addBounded(
      compositeBase.diagnostics.sourceRecordsInspected,
      timingState.returns.length,
      CONTINUITY_CHANGE_LIMITS.maxSourceRecords,
      "source-record accounting"
    ),
    stringBytesInspected: addBounded(
      compositeBase.diagnostics.stringBytesInspected,
      timingInspection.stringBytes,
      CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes,
      "string-byte accounting"
    )
  });

  return sealContinuityObservation({
    schemaVersion: 1,
    authority: "caller-declared-observation",
    observedAt: base.observedAt,
    projection,
    diagnostics
  });
}

/**
 * Reads the active composite scope through the neutral bounded Working Graph
 * operator. The result is evidence for agent context, never source authority.
 */
export async function readContinuityShadowReturnWorkingGraph(
  options: ReadContinuityShadowReturnWorkingGraphOptions
): Promise<AttuneGraphOperatorResult> {
  const normalized = workingGraphOptionsRecord(options);
  const graph = await openLocalAttuneGraph({
    databasePath: normalized.databasePath,
    scope: {
      sourceId: continuityCompositeSourceId,
      threadId: normalized.threadId
    }
  });
  let primaryFailure: unknown;
  let result: AttuneGraphOperatorResult | undefined;
  try {
    result = await graph.execute({
      operator: "working-graph@1",
      seed: deriveContinuityThreadGraphRef(
        continuityCompositeSourceId,
        normalized.threadId
      ),
      now: normalized.now,
      maxEstimatedTokens: normalized.maxEstimatedTokens
    });
  } catch (cause) {
    primaryFailure = cause;
  }
  try {
    await graph.close();
  } catch (cause) {
    primaryFailure ??= cause;
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  return result!;
}
