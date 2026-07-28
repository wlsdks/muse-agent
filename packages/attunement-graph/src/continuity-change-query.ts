import { createHash } from "node:crypto";

import {
  ContinuityProjectionError,
  continuityThreadGraphRef,
  diffContinuityProjections,
  projectContinuityState,
  type ContinuityGraphProjection,
  type ContinuityProjectionInput,
  type ContinuityProjectionScope
} from "./continuity-projection.js";
import {
  CONTINUITY_CHANGE_LIMITS,
  buildContinuityChangeCandidates,
  buildContinuityPathTree,
  classifyContinuityTemporal,
  continuitySupportEligible,
  explainContinuityPath,
  isContinuityNoOp,
  sameContinuityScope
} from "./continuity-change-semantics.js";
import type {
  GraphAssertion,
  GraphDirection,
  GraphEvidenceRef,
  GraphRef
} from "./types.js";
import { evidenceRefKey } from "./validation.js";

export { CONTINUITY_CHANGE_LIMITS } from "./continuity-change-semantics.js";

export const CONTINUITY_CHANGE_QUERY_VERSION =
  "continuity-change-query-v1" as const;
export const CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE =
  "muse.attunement.continuity-projection" as const;

export type ContinuityChangeQueryErrorCode =
  | "INVALID_INPUT"
  | "SOURCE_BUDGET_EXCEEDED"
  | "RAW_DELTA_BUDGET_EXCEEDED";

export class ContinuityChangeQueryError extends Error {
  readonly code: ContinuityChangeQueryErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuityChangeQueryErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuityChangeQueryError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ContinuityChangeBoundary {
  readonly authority: "caller-declared-observation";
  readonly observedAt: string;
  readonly schemaVersion: 1;
  readonly scope: ContinuityProjectionScope;
  readonly sourceRef: GraphEvidenceRef;
}

export type ContinuityChangeTemporalBasis = "world-valid" | "learned-after";
export type ContinuityChangeKind = "added" | "revised";
export type ContinuityChangeStatus =
  | "complete"
  | "partial"
  | "no-change"
  | "abstained";

export type ContinuityChangeAbstentionCode =
  | "AMBIGUOUS_REVISION"
  | "REMOVAL_TIME_UNKNOWN"
  | "OUTSIDE_INTERVAL"
  | "NO_PATH_WITHIN_DEPTH"
  | "INCONSISTENT_OBSERVATION"
  | "VISITED_REF_BUDGET_EXCEEDED"
  | "OUTPUT_BUDGET_EXCEEDED";

export interface ContinuityChangePathStep {
  readonly assertionId: string;
  readonly derivation: GraphAssertion["derivation"];
  readonly direction: Exclude<GraphDirection, "both">;
  readonly epistemicClass: GraphAssertion["epistemicClass"];
  readonly object: GraphRef;
  readonly predicate: GraphAssertion["predicate"];
  readonly sourceRefs: readonly GraphEvidenceRef[];
  readonly subject: GraphRef;
}

export interface ExplainedContinuityChange {
  readonly assertion: GraphAssertion;
  readonly kind: ContinuityChangeKind;
  readonly path: readonly ContinuityChangePathStep[];
  readonly replacedAssertionId?: string;
  readonly temporalBasis: ContinuityChangeTemporalBasis;
}

export interface ContinuityChangeAbstention {
  readonly affectedCount: number;
  readonly affectedAssertionIds: readonly string[];
  readonly code: ContinuityChangeAbstentionCode;
  readonly global: boolean;
}

export interface ContinuityChangeObservationDiagnostics {
  readonly descriptorsInspected: number;
  readonly projectedAssertions: number;
  readonly sourceRecordsInspected: number;
  readonly stringBytesInspected: number;
}

export interface ContinuityChangeDiagnostics {
  readonly abstainedCount: number;
  readonly answeredCount: number;
  readonly candidateCount: number;
  readonly complete: boolean;
  readonly consideredAssertions: number;
  readonly current: ContinuityChangeObservationDiagnostics;
  readonly diffComparedAssertions: number;
  readonly embeddingCalls: 0;
  readonly maxDepthReached: number;
  readonly modelCalls: 0;
  readonly previous: ContinuityChangeObservationDiagnostics;
  readonly rawDeltaCount: number;
  readonly visitedRefs: number;
}

export interface ContinuityChangeObservationRef {
  readonly projectionVersion: string;
  readonly sourceObservedAt: string;
  readonly sourceVersion: string;
}

export interface ExplainedContinuityChangeResult {
  readonly abstentions: readonly ContinuityChangeAbstention[];
  readonly boundary: ContinuityChangeBoundary;
  readonly changes: readonly ExplainedContinuityChange[];
  readonly current: ContinuityChangeObservationRef;
  readonly diagnostics: ContinuityChangeDiagnostics;
  readonly previous: ContinuityChangeObservationRef;
  readonly queryVersion: typeof CONTINUITY_CHANGE_QUERY_VERSION;
  readonly resultId: string;
  readonly schemaVersion: 1;
  readonly scope: ContinuityProjectionScope;
  readonly status: ContinuityChangeStatus;
}

interface Inspection {
  readonly descriptors: number;
  readonly stringBytes: number;
}

interface SourceAccounting extends Inspection {
  readonly sourceRecords: number;
}

function queryError(
  code: ContinuityChangeQueryErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuityChangeQueryError(code, message, details);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function inspectData(
  value: unknown,
  label: string,
  maxDescriptors: number = CONTINUITY_CHANGE_LIMITS.maxDescriptors,
  maxStringBytes: number = CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes
): Inspection {
  let descriptors = 0;
  let stringBytes = 0;
  const active = new WeakSet<object>();

  const countString = (text: string): void => {
    const bytes = utf8Bytes(text);
    if (bytes > CONTINUITY_CHANGE_LIMITS.maxStringBytes) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} contains an oversized string`, {
        bytes,
        limit: CONTINUITY_CHANGE_LIMITS.maxStringBytes
      });
    }
    stringBytes += bytes;
    if (stringBytes > maxStringBytes) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds its string-byte budget`, {
        bytes: stringBytes,
        limit: maxStringBytes
      });
    }
  };

  const visit = (current: unknown, depth: number): void => {
    if (typeof current === "string") {
      countString(current);
      return;
    }
    if (
      current === null
      || typeof current === "boolean"
      || typeof current === "number"
      || current === undefined
    ) {
      return;
    }
    if (typeof current !== "object") {
      queryError("INVALID_INPUT", `${label} must contain only plain data`);
    }
    if (depth > CONTINUITY_CHANGE_LIMITS.maxNestingDepth) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds its nesting budget`, {
        depth,
        limit: CONTINUITY_CHANGE_LIMITS.maxNestingDepth
      });
    }
    const object = current as object;
    if (active.has(object)) {
      queryError("INVALID_INPUT", `${label} must not contain cycles`);
    }
    const prototype = Object.getPrototypeOf(object);
    if (
      !Array.isArray(object)
      && prototype !== Object.prototype
      && prototype !== null
    ) {
      queryError("INVALID_INPUT", `${label} must contain only plain objects and arrays`);
    }
    active.add(object);
    const keys = Reflect.ownKeys(object);
    for (const key of keys) {
      if (typeof key !== "string") {
        queryError("INVALID_INPUT", `${label} must not contain symbol keys`);
      }
      countString(key);
      descriptors += 1;
      if (descriptors > maxDescriptors) {
        queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds its descriptor budget`, {
          descriptors,
          limit: maxDescriptors
        });
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) {
        queryError("INVALID_INPUT", `${label} must not contain accessors`);
      }
      visit(descriptor.value, depth + 1);
    }
    active.delete(object);
  };

  visit(value, 0);
  return Object.freeze({ descriptors, stringBytes });
}

function dataObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[] = allowed
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    queryError("INVALID_INPUT", `${label} must not contain symbol keys`);
  }
  const names = keys as string[];
  if (
    names.some((key) => !allowed.includes(key))
    || required.some((key) => !names.includes(key))
  ) {
    queryError("INVALID_INPUT", `${label} has missing or unknown fields`);
  }
  const output: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) {
      queryError("INVALID_INPUT", `${label}.${name} must be a data property`);
    }
    output[name] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) queryError("INVALID_INPUT", `${label} must be an array`);
  return value;
}

function dataString(value: unknown, label: string): string {
  if (typeof value !== "string") queryError("INVALID_INPUT", `${label} must be text`);
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = dataString(value, label);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    queryError("INVALID_INPUT", `${label} must be a canonical ISO instant`);
  }
  return text;
}

function parseScope(value: unknown, label: string): ContinuityProjectionScope {
  const record = dataObject(value, label, ["sourceId", "threadId"]);
  const sourceId = dataString(record.sourceId, `${label}.sourceId`);
  const threadId = dataString(record.threadId, `${label}.threadId`);
  return Object.freeze({ sourceId, threadId });
}

function parseProjectionInput(value: unknown, label: string): ContinuityProjectionInput {
  const record = dataObject(value, label, ["scope", "sourceObservedAt", "state"]);
  return Object.freeze({
    scope: parseScope(record.scope, `${label}.scope`),
    sourceObservedAt: canonicalInstant(
      record.sourceObservedAt,
      `${label}.sourceObservedAt`
    ),
    state: record.state
  });
}

function parseEvidenceRef(value: unknown, label: string): GraphEvidenceRef {
  const record = dataObject(value, label, ["id", "namespace", "version"]);
  return Object.freeze({
    id: dataString(record.id, `${label}.id`),
    namespace: dataString(record.namespace, `${label}.namespace`),
    version: dataString(record.version, `${label}.version`)
  });
}

function parseBoundary(value: unknown): ContinuityChangeBoundary {
  const record = dataObject(value, "boundary", [
    "authority",
    "observedAt",
    "schemaVersion",
    "scope",
    "sourceRef"
  ]);
  if (record.schemaVersion !== 1) {
    queryError("INVALID_INPUT", "boundary.schemaVersion must be 1");
  }
  if (record.authority !== "caller-declared-observation") {
    queryError("INVALID_INPUT", "boundary.authority is invalid");
  }
  return Object.freeze({
    authority: "caller-declared-observation" as const,
    observedAt: canonicalInstant(record.observedAt, "boundary.observedAt"),
    schemaVersion: 1 as const,
    scope: parseScope(record.scope, "boundary.scope"),
    sourceRef: parseEvidenceRef(record.sourceRef, "boundary.sourceRef")
  });
}

function readField(value: unknown, key: string, label: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    queryError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    queryError("INVALID_INPUT", `${label}.${key} must be a data property`);
  }
  return descriptor.value;
}

function countSource(input: ContinuityProjectionInput, label: string): SourceAccounting {
  const inspection = inspectData(input.state, `${label}.state`);
  const state = dataObject(
    input.state,
    `${label}.state`,
    [
      "deliveries",
      "interactionReceipts",
      "nextPolicyVersion",
      "resetReceipts",
      "schemaVersion",
      "threads",
      "undoResetReceipts"
    ]
  );
  const threads = dataArray(state.threads, `${label}.state.threads`);
  const deliveries = dataArray(state.deliveries, `${label}.state.deliveries`);
  const interactions = dataArray(
    state.interactionReceipts,
    `${label}.state.interactionReceipts`
  );
  const resets = dataArray(state.resetReceipts, `${label}.state.resetReceipts`);
  const undos = dataArray(
    state.undoResetReceipts,
    `${label}.state.undoResetReceipts`
  );
  let links = 0;
  let selectedLinks = 0;
  for (const [index, thread] of threads.entries()) {
    const threadLabel = `${label}.state.threads[${index.toString()}]`;
    const threadId = readField(thread, "id", threadLabel);
    const threadLinks = dataArray(readField(thread, "links", threadLabel), `${threadLabel}.links`);
    links += threadLinks.length;
    if (threadId === input.scope.threadId) selectedLinks += threadLinks.length;
  }
  let evidenceRefs = 0;
  let selectedDeliveries = 0;
  let selectedEvidenceRefs = 0;
  for (const [index, delivery] of deliveries.entries()) {
    const deliveryLabel = `${label}.state.deliveries[${index.toString()}]`;
    const deliveryThread = readField(delivery, "threadId", deliveryLabel);
    const refs = dataArray(
      readField(delivery, "evidenceRefs", deliveryLabel),
      `${deliveryLabel}.evidenceRefs`
    );
    evidenceRefs += refs.length;
    if (deliveryThread === input.scope.threadId) {
      selectedDeliveries += 1;
      selectedEvidenceRefs += refs.length;
    }
  }
  const selectedInteractions = interactions.filter((item, index) =>
    readField(item, "threadId", `${label}.state.interactionReceipts[${index.toString()}]`)
      === input.scope.threadId
  ).length;
  const selectedResets = resets.filter((item, index) =>
    readField(item, "threadId", `${label}.state.resetReceipts[${index.toString()}]`)
      === input.scope.threadId
  ).length;
  const selectedUndos = undos.filter((item, index) =>
    readField(item, "threadId", `${label}.state.undoResetReceipts[${index.toString()}]`)
      === input.scope.threadId
  ).length;
  const sourceRecords =
    threads.length
    + links
    + deliveries.length
    + evidenceRefs
    + interactions.length
    + resets.length
    + undos.length;
  const checks: readonly [number, number, string][] = [
    [threads.length, CONTINUITY_CHANGE_LIMITS.maxThreads, "threads"],
    [links, CONTINUITY_CHANGE_LIMITS.maxLinks, "links"],
    [deliveries.length, CONTINUITY_CHANGE_LIMITS.maxSourceDeliveries, "deliveries"],
    [evidenceRefs, CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs, "evidence refs"],
    [interactions.length, CONTINUITY_CHANGE_LIMITS.maxInteractions, "interactions"],
    [resets.length, CONTINUITY_CHANGE_LIMITS.maxResets, "resets"],
    [undos.length, CONTINUITY_CHANGE_LIMITS.maxUndos, "undos"],
    [sourceRecords, CONTINUITY_CHANGE_LIMITS.maxSourceRecords, "source records"],
    [selectedLinks, CONTINUITY_CHANGE_LIMITS.maxSelectedLinks, "selected links"],
    [
      selectedDeliveries,
      CONTINUITY_CHANGE_LIMITS.maxSelectedDeliveries,
      "selected deliveries"
    ],
    [
      selectedEvidenceRefs,
      CONTINUITY_CHANGE_LIMITS.maxSelectedEvidenceRefs,
      "selected evidence refs"
    ],
    [
      selectedInteractions,
      CONTINUITY_CHANGE_LIMITS.maxSelectedInteractions,
      "selected interactions"
    ],
    [selectedResets, CONTINUITY_CHANGE_LIMITS.maxSelectedResets, "selected resets"],
    [selectedUndos, CONTINUITY_CHANGE_LIMITS.maxSelectedUndos, "selected undos"]
  ];
  for (const [actual, limit, name] of checks) {
    if (actual > limit) {
      queryError("SOURCE_BUDGET_EXCEEDED", `${label} exceeds ${name} budget`, {
        actual,
        limit
      });
    }
  }
  return Object.freeze({ ...inspection, sourceRecords });
}

function project(
  input: ContinuityProjectionInput,
  accounting: SourceAccounting
): {
  readonly accounting: ContinuityChangeObservationDiagnostics;
  readonly projection: ContinuityGraphProjection;
} {
  try {
    const projection = projectContinuityState(input);
    if (
      projection.assertions.length
      > CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions
    ) {
      queryError("SOURCE_BUDGET_EXCEEDED", "projection exceeds query budget", {
        actual: projection.assertions.length,
        limit: CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions
      });
    }
    return Object.freeze({
      accounting: Object.freeze({
        descriptorsInspected: accounting.descriptors,
        projectedAssertions: projection.assertions.length,
        sourceRecordsInspected: accounting.sourceRecords,
        stringBytesInspected: accounting.stringBytes
      }),
      projection
    });
  } catch (cause) {
    if (cause instanceof ContinuityChangeQueryError) throw cause;
    if (cause instanceof ContinuityProjectionError) {
      if (cause.code === "PROJECTION_LIMIT") {
        queryError("SOURCE_BUDGET_EXCEEDED", cause.message, {
          causeCode: cause.code
        });
      }
      queryError("INVALID_INPUT", cause.message, { causeCode: cause.code });
    }
    throw cause;
  }
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) output[key] = canonicalValue(child);
  }
  return output;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex")}`;
}

function instant(value: string): number {
  return new Date(value).getTime();
}

function observationRef(
  input: ContinuityProjectionInput,
  projection: ContinuityGraphProjection
): ContinuityChangeObservationRef {
  return Object.freeze({
    projectionVersion: projection.projectionVersion,
    sourceObservedAt: input.sourceObservedAt,
    sourceVersion: projection.sourceVersion
  });
}

function makeResult(
  base: Omit<ExplainedContinuityChangeResult, "resultId">
): ExplainedContinuityChangeResult {
  const frozen = Object.freeze(base);
  return Object.freeze({ ...frozen, resultId: digest(frozen) });
}

function statusFor(answered: number, abstained: number): ContinuityChangeStatus {
  if (answered > 0 && abstained === 0) return "complete";
  if (answered > 0) return "partial";
  return "abstained";
}

export function explainContinuityChanges(
  input: unknown
): ExplainedContinuityChangeResult {
  inspectData(
    input,
    "continuity change input",
    CONTINUITY_CHANGE_LIMITS.maxDescriptors * 2 + 128,
    CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes * 2 + 16_384
  );
  const envelope = dataObject(input, "continuity change input", [
    "boundary",
    "current",
    "previous",
    "schemaVersion"
  ]);
  if (envelope.schemaVersion !== 1) {
    queryError("INVALID_INPUT", "continuity change input.schemaVersion must be 1");
  }
  const previousInput = parseProjectionInput(envelope.previous, "previous");
  const currentInput = parseProjectionInput(envelope.current, "current");
  const boundary = parseBoundary(envelope.boundary);
  if (
    !sameContinuityScope(previousInput.scope, currentInput.scope)
    || !sameContinuityScope(previousInput.scope, boundary.scope)
  ) {
    queryError("INVALID_INPUT", "previous, current, and boundary scopes must match");
  }
  if (
    previousInput.sourceObservedAt !== boundary.observedAt
    || instant(currentInput.sourceObservedAt) < instant(boundary.observedAt)
  ) {
    queryError("INVALID_INPUT", "boundary observation interval is invalid");
  }
  const previousAccounting = countSource(previousInput, "previous");
  const currentAccounting = countSource(currentInput, "current");
  const previous = project(previousInput, previousAccounting);
  const current = project(currentInput, currentAccounting);
  const expectedBoundaryRef: GraphEvidenceRef = {
    id: previous.projection.sourceVersion,
    namespace: CONTINUITY_PROJECTION_BOUNDARY_NAMESPACE,
    version: previous.projection.projectionVersion
  };
  if (evidenceRefKey(boundary.sourceRef) !== evidenceRefKey(expectedBoundaryRef)) {
    queryError("INVALID_INPUT", "boundary source ref does not bind the previous projection");
  }

  const base = {
    boundary,
    current: observationRef(currentInput, current.projection),
    previous: observationRef(previousInput, previous.projection),
    queryVersion: CONTINUITY_CHANGE_QUERY_VERSION,
    schemaVersion: 1 as const,
    scope: previous.projection.scope
  };
  const emptyDiagnostics = (
    rawDeltaCount: number,
    candidateCount: number,
    answeredCount: number,
    abstainedCount: number,
    consideredAssertions: number,
    visitedRefs: number,
    maxDepthReached: number,
    complete: boolean
  ): ContinuityChangeDiagnostics => Object.freeze({
    abstainedCount,
    answeredCount,
    candidateCount,
    complete,
    consideredAssertions,
    current: current.accounting,
    diffComparedAssertions:
      previous.projection.assertions.length + current.projection.assertions.length,
    embeddingCalls: 0 as const,
    maxDepthReached,
    modelCalls: 0 as const,
    previous: previous.accounting,
    rawDeltaCount,
    visitedRefs
  });

  const inconsistent = [
    ...previous.projection.assertions
      .filter((item) => instant(item.recordedAt) > instant(previousInput.sourceObservedAt)),
    ...current.projection.assertions
      .filter((item) => instant(item.recordedAt) > instant(currentInput.sourceObservedAt))
  ].map((item) => item.id).sort();

  if (isContinuityNoOp(previous.projection, current.projection)) {
    if (inconsistent.length > 0) {
      return makeResult({
        ...base,
        abstentions: Object.freeze([Object.freeze({
          affectedCount: 0,
          affectedAssertionIds: Object.freeze(inconsistent),
          code: "INCONSISTENT_OBSERVATION" as const,
          global: true
        })]),
        changes: Object.freeze([]),
        diagnostics: emptyDiagnostics(0, 0, 0, 1, 0, 0, 0, false),
        status: "abstained"
      });
    }
    return makeResult({
      ...base,
      abstentions: Object.freeze([]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(0, 0, 0, 0, 0, 0, 0, true),
      status: "no-change"
    });
  }

  const delta = diffContinuityProjections(previous.projection, current.projection);
  const rawDeltaCount = delta.append.length + delta.forgetAssertionIds.length;
  if (rawDeltaCount > CONTINUITY_CHANGE_LIMITS.maxRawDelta) {
    queryError("RAW_DELTA_BUDGET_EXCEEDED", "raw delta exceeds query budget", {
      limit: CONTINUITY_CHANGE_LIMITS.maxRawDelta,
      rawDeltaCount
    });
  }
  const previousById = new Map(
    previous.projection.assertions.map((item) => [item.id, item])
  );
  const removals = delta.forgetAssertionIds
    .map((id) => previousById.get(id))
    .filter((item): item is GraphAssertion => Boolean(item));
  const candidates = buildContinuityChangeCandidates(removals, delta.append);
  const candidateIds = candidates.flatMap((candidate) => [
    ...candidate.removals.map((item) => item.id),
    ...candidate.additions.map((item) => item.id)
  ]).sort();
  if (inconsistent.length > 0) {
    return makeResult({
      ...base,
      abstentions: Object.freeze([Object.freeze({
        affectedCount: candidates.length,
        affectedAssertionIds: Object.freeze(candidateIds),
        code: "INCONSISTENT_OBSERVATION" as const,
        global: true
      })]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(
        rawDeltaCount,
        candidates.length,
        0,
        1,
        0,
        0,
        0,
        false
      ),
      status: "abstained"
    });
  }

  const appendedIds = new Set(delta.append.map((item) => item.id));
  const unchangedIds = new Set(delta.unchangedAssertionIds);
  const support = current.projection.assertions
    .filter((item) =>
      unchangedIds.has(item.id)
      && !appendedIds.has(item.id)
      && continuitySupportEligible(item, currentInput.sourceObservedAt)
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const tree = buildContinuityPathTree(
    continuityThreadGraphRef(base.scope),
    support
  );
  if (tree.truncated) {
    return makeResult({
      ...base,
      abstentions: Object.freeze([Object.freeze({
        affectedCount: candidates.length,
        affectedAssertionIds: Object.freeze(candidateIds),
        code: "VISITED_REF_BUDGET_EXCEEDED" as const,
        global: true
      })]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(
        rawDeltaCount,
        candidates.length,
        0,
        1,
        support.length,
        tree.visitedRefs,
        tree.maxDepthReached,
        false
      ),
      status: "abstained"
    });
  }

  const changes: ExplainedContinuityChange[] = [];
  const abstentions: ContinuityChangeAbstention[] = [];
  for (const candidate of candidates) {
    const affected = Object.freeze([
      ...candidate.removals.map((item) => item.id),
      ...candidate.additions.map((item) => item.id)
    ].sort());
    if (candidate.type === "ambiguous") {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "AMBIGUOUS_REVISION",
        global: false
      }));
      continue;
    }
    if (candidate.type === "removal") {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "REMOVAL_TIME_UNKNOWN",
        global: false
      }));
      continue;
    }
    const assertion = candidate.additions[0];
    if (!assertion) continue;
    const basis = classifyContinuityTemporal(
      assertion,
      boundary.observedAt,
      currentInput.sourceObservedAt
    );
    if (!basis) {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "OUTSIDE_INTERVAL",
        global: false
      }));
      continue;
    }
    const path = explainContinuityPath(assertion, tree);
    if (!path || path.length > CONTINUITY_CHANGE_LIMITS.maxDepth) {
      abstentions.push(Object.freeze({
        affectedCount: affected.length,
        affectedAssertionIds: affected,
        code: "NO_PATH_WITHIN_DEPTH",
        global: false
      }));
      continue;
    }
    changes.push(Object.freeze({
      assertion,
      kind: candidate.type === "revision" ? "revised" : "added",
      path,
      ...(candidate.type === "revision"
        ? { replacedAssertionId: candidate.removals[0]?.id }
        : {}),
      temporalBasis: basis
    }));
  }
  changes.sort((a, b) => a.assertion.id.localeCompare(b.assertion.id));
  abstentions.sort((a, b) =>
    a.code.localeCompare(b.code)
    || (a.affectedAssertionIds[0] ?? "").localeCompare(b.affectedAssertionIds[0] ?? "")
  );
  if (changes.length > CONTINUITY_CHANGE_LIMITS.maxExplainedChanges) {
    return makeResult({
      ...base,
      abstentions: Object.freeze([Object.freeze({
        affectedCount: candidates.length,
        affectedAssertionIds: Object.freeze(candidateIds),
        code: "OUTPUT_BUDGET_EXCEEDED" as const,
        global: true
      })]),
      changes: Object.freeze([]),
      diagnostics: emptyDiagnostics(
        rawDeltaCount,
        candidates.length,
        0,
        1,
        support.length,
        tree.visitedRefs,
        tree.maxDepthReached,
        false
      ),
      status: "abstained"
    });
  }
  const status = rawDeltaCount === 0
    ? "no-change"
    : statusFor(changes.length, abstentions.length);
  return makeResult({
    ...base,
    abstentions: Object.freeze(abstentions),
    changes: Object.freeze(changes),
    diagnostics: emptyDiagnostics(
      rawDeltaCount,
      candidates.length,
      changes.length,
      abstentions.length,
      support.length,
      tree.visitedRefs,
      tree.maxDepthReached,
      true
    ),
    status
  });
}
