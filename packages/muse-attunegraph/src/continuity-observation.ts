import { createHash } from "node:crypto";

import {
  CONTINUITY_PROJECTION_RULE_VERSION,
  type ContinuityGraphProjection,
  type ContinuityProjectionScope,
  type ContinuityProjectionTimestampBasis
} from "./continuity-projection.js";
import {
  CONTINUITY_CHANGE_LIMITS
} from "./continuity-change-semantics.js";
import {
  comparePreparedContinuityObservations,
  type PreparedContinuityComparisonObservation
} from "./continuity-change-comparison.js";
import {
  type ContinuityChangeObservationDiagnostics,
  type ExplainedContinuityChangeResult
} from "./continuity-change-contracts.js";
import {
  ContinuityChangeQueryError,
  type ContinuityChangeQueryErrorCode
} from "./continuity-change-primitives.js";
import {
  prepareContinuitySourceObservation,
  type PreparedContinuitySourceObservation
} from "./continuity-source-observation.js";
import {
  continuityReceiptComparisonBoundary,
  preparedContinuityReceiptObservation
} from "./continuity-observation-comparison.js";
import type {
  GraphAssertion,
  GraphEvidenceRef
} from "@attunegraph/core";
import {
  evidenceRefKey,
  normalizeGraphAssertionBatch
} from "@attunegraph/core/extension-kit";

export const CONTINUITY_OBSERVATION_FORMAT_VERSION =
  "muse.continuity-observation.v1" as const;

const HASH_DOMAIN = "muse.attunement.continuity-observation.v1\0";
const RECEIPT_ID_PREFIX = "muse-continuity-observation:v1:sha256:";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RECEIPT_ID_PATTERN =
  /^muse-continuity-observation:v1:sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_SCOPE_TEXT_BYTES = 512;

export type ContinuityObservationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RECEIPT"
  | "BUDGET_EXCEEDED"
  | "INTEGRITY_MISMATCH";

const PREPARATION_ERROR_CODE = {
  INVALID_INPUT: "INVALID_INPUT",
  RAW_DELTA_BUDGET_EXCEEDED: "INVALID_INPUT",
  SOURCE_BUDGET_EXCEEDED: "BUDGET_EXCEEDED"
} as const satisfies Record<
  ContinuityChangeQueryErrorCode,
  ContinuityObservationErrorCode
>;

const COMPARISON_ERROR_CODE = {
  INVALID_INPUT: "INVALID_INPUT",
  RAW_DELTA_BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  SOURCE_BUDGET_EXCEEDED: "BUDGET_EXCEEDED"
} as const satisfies Record<
  ContinuityChangeQueryErrorCode,
  ContinuityObservationErrorCode
>;

export class ContinuityObservationError extends Error {
  readonly code: ContinuityObservationErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuityObservationErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuityObservationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface SealContinuityObservationInput {
  readonly schemaVersion: 1;
  readonly authority: "caller-declared-observation";
  readonly observedAt: string;
  readonly projection: ContinuityGraphProjection;
  readonly diagnostics: ContinuityChangeObservationDiagnostics;
}

export interface ContinuityObservationReceipt {
  readonly schemaVersion: 1;
  readonly formatVersion: typeof CONTINUITY_OBSERVATION_FORMAT_VERSION;
  readonly authority: "caller-declared-observation";
  readonly observedAt: string;
  readonly projection: ContinuityGraphProjection;
  readonly diagnostics: ContinuityChangeObservationDiagnostics;
  readonly receiptId: string;
}

interface InspectionBudget {
  descriptors: number;
  stringBytes: number;
}

interface ParseContext {
  readonly invalidCode: "INVALID_INPUT" | "INVALID_RECEIPT";
}

interface ReceiptComparisonEnvelope {
  readonly current: unknown;
  readonly previousReceipt: unknown;
  readonly schemaVersion: unknown;
}

function fail(
  code: ContinuityObservationErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuityObservationError(code, message, details);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function inspectPlainData(value: unknown, label: string): void {
  const budget: InspectionBudget = { descriptors: 0, stringBytes: 0 };
  const active = new WeakSet<object>();

  const countString = (text: string): void => {
    const bytes = utf8Bytes(text);
    if (bytes > CONTINUITY_CHANGE_LIMITS.maxStringBytes) {
      fail("BUDGET_EXCEEDED", `${label} contains an oversized string`, {
        bytes,
        limit: CONTINUITY_CHANGE_LIMITS.maxStringBytes
      });
    }
    budget.stringBytes += bytes;
    if (budget.stringBytes > CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes) {
      fail("BUDGET_EXCEEDED", `${label} exceeds its string-byte budget`, {
        bytes: budget.stringBytes,
        limit: CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes
      });
    }
  };

  const visit = (current: unknown, depth: number): void => {
    if (depth > CONTINUITY_CHANGE_LIMITS.maxNestingDepth) {
      fail("BUDGET_EXCEEDED", `${label} exceeds its nesting budget`, {
        depth,
        limit: CONTINUITY_CHANGE_LIMITS.maxNestingDepth
      });
    }
    if (typeof current === "string") {
      countString(current);
      return;
    }
    if (
      current === null
      || typeof current === "boolean"
      || (typeof current === "number" && Number.isFinite(current))
    ) {
      return;
    }
    if (typeof current !== "object") {
      fail("INVALID_INPUT", `${label} must contain only JSON-compatible plain data`);
    }
    if (active.has(current)) {
      fail("INVALID_INPUT", `${label} must not contain cycles`);
    }
    const prototype = Object.getPrototypeOf(current);
    if (
      Array.isArray(current)
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) {
      fail("INVALID_INPUT", `${label} must contain only plain objects and arrays`);
    }
    active.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const ownKeys = Reflect.ownKeys(current);
    budget.descriptors += ownKeys.length;
    if (budget.descriptors > CONTINUITY_CHANGE_LIMITS.maxDescriptors) {
      fail("BUDGET_EXCEEDED", `${label} exceeds its descriptor budget`, {
        descriptors: budget.descriptors,
        limit: CONTINUITY_CHANGE_LIMITS.maxDescriptors
      });
    }
    if (ownKeys.some((key) => typeof key !== "string")) {
      fail("INVALID_INPUT", `${label} must not contain symbol properties`);
    }
    if (Array.isArray(current)) {
      const lengthDescriptor = descriptors["length"];
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        fail("INVALID_INPUT", `${label} contains an invalid array`);
      }
      const allowed = new Set(["length"]);
      for (let index = 0; index < (length as number); index += 1) {
        const key = index.toString();
        allowed.add(key);
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) {
          fail("INVALID_INPUT", `${label} arrays must be dense data arrays`);
        }
        visit(descriptor.value, depth + 1);
      }
      if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
        fail("INVALID_INPUT", `${label} arrays must not contain extra properties`);
      }
    } else {
      for (const key of ownKeys as string[]) {
        countString(key);
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) {
          fail("INVALID_INPUT", `${label} must contain only data properties`);
        }
        visit(descriptor.value, depth + 1);
      }
    }
    active.delete(current);
  };

  visit(value, 0);
}

function dataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
  context: ParseContext
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(context.invalidCode, `${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.includes(key))) {
    fail(context.invalidCode, `${label} contains an unknown field`);
  }
  if (required.some((key) => !keys.includes(key))) {
    fail(context.invalidCode, `${label} is missing a required field`);
  }
  return record;
}

function receiptComparisonEnvelope(value: unknown): ReceiptComparisonEnvelope {
  const label = "receipt comparison input";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_INPUT", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_INPUT", `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    fail("INVALID_INPUT", `${label} must not contain symbol fields`);
  }
  const allowed = ["current", "previousReceipt", "schemaVersion"] as const;
  if ((keys as string[]).some((key) => !allowed.includes(
    key as (typeof allowed)[number]
  ))) {
    fail("INVALID_INPUT", `${label} contains an unknown field`);
  }
  if (allowed.some((key) => !keys.includes(key))) {
    fail("INVALID_INPUT", `${label} is missing a required field`);
  }
  const descriptors: PropertyDescriptorMap = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail("INVALID_INPUT", `${label} fields must be data properties`);
    }
    descriptors[key] = descriptor;
  }
  return Object.freeze({
    current: descriptors.current?.value,
    previousReceipt: descriptors.previousReceipt?.value,
    schemaVersion: descriptors.schemaVersion?.value
  });
}

function dataArray(
  value: unknown,
  label: string,
  maximum: number,
  context: ParseContext
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    if (Array.isArray(value)) {
      fail("BUDGET_EXCEEDED", `${label} exceeds its item budget`, {
        items: value.length,
        limit: maximum
      });
    }
    fail(context.invalidCode, `${label} must be an array`);
  }
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
  context: ParseContext
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || CONTROL_CHARACTERS.test(value)
  ) {
    fail(context.invalidCode, `${label} must be bounded non-empty text`);
  }
  const bytes = utf8Bytes(value);
  if (bytes > maximumBytes) {
    fail("BUDGET_EXCEEDED", `${label} exceeds its byte budget`, {
      bytes,
      limit: maximumBytes
    });
  }
  return value;
}

function canonicalInstant(
  value: unknown,
  label: string,
  context: ParseContext
): string {
  if (typeof value !== "string") {
    fail(context.invalidCode, `${label} must be a canonical ISO instant`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(context.invalidCode, `${label} must be a canonical ISO instant`);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) output[key] = canonicalValue(child);
  }
  return output;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectionDigest(projection: Pick<
  ContinuityGraphProjection,
  "assertions" | "ruleVersion" | "scope"
>): string {
  return `sha256:${sha256(canonicalJson({
    assertions: projection.assertions,
    ruleVersion: projection.ruleVersion,
    scope: projection.scope
  }))}`;
}

function receiptId(body: Omit<ContinuityObservationReceipt, "receiptId">): string {
  return `${RECEIPT_ID_PREFIX}${sha256(HASH_DOMAIN + canonicalJson(body))}`;
}

function parseScope(
  value: unknown,
  context: ParseContext
): ContinuityProjectionScope {
  const record = dataRecord(
    value,
    "projection.scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"],
    context
  );
  const sourceId = boundedText(
    record.sourceId,
    "projection.scope.sourceId",
    128,
    context
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(sourceId)) {
    fail(context.invalidCode, "projection.scope.sourceId is not a logical identifier");
  }
  return Object.freeze({
    sourceId,
    threadId: boundedText(
      record.threadId,
      "projection.scope.threadId",
      MAX_SCOPE_TEXT_BYTES,
      context
    )
  });
}

function parseEvidenceRef(
  value: unknown,
  label: string,
  context: ParseContext
): GraphEvidenceRef {
  const record = dataRecord(
    value,
    label,
    ["id", "namespace", "version"],
    ["id", "namespace"],
    context
  );
  const version = Object.hasOwn(record, "version")
    ? boundedText(record.version, `${label}.version`, 128, context)
    : undefined;
  return Object.freeze({
    id: boundedText(record.id, `${label}.id`, 512, context),
    namespace: boundedText(record.namespace, `${label}.namespace`, 128, context),
    ...(version ? { version } : {})
  });
}

function parseProjection(
  value: unknown,
  context: ParseContext
): ContinuityGraphProjection {
  const record = dataRecord(
    value,
    "projection",
    [
      "schemaVersion",
      "ruleVersion",
      "scope",
      "sourceVersion",
      "projectionVersion",
      "assertions",
      "timestampBasis"
    ],
    [
      "schemaVersion",
      "ruleVersion",
      "scope",
      "sourceVersion",
      "projectionVersion",
      "assertions",
      "timestampBasis"
    ],
    context
  );
  if (record.schemaVersion !== 1) {
    fail(context.invalidCode, "projection.schemaVersion must be 1");
  }
  if (record.ruleVersion !== CONTINUITY_PROJECTION_RULE_VERSION) {
    fail(context.invalidCode, "projection.ruleVersion is not supported");
  }
  const scope = parseScope(record.scope, context);
  const rawAssertions = dataArray(
    record.assertions,
    "projection.assertions",
    CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions,
    context
  );
  let assertions: readonly GraphAssertion[];
  try {
    assertions = normalizeGraphAssertionBatch(rawAssertions)
      .slice()
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    fail(context.invalidCode, "projection.assertions are invalid");
  }
  if (assertions.length > CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions) {
    fail("BUDGET_EXCEEDED", "projection.assertions exceed the observation budget", {
      assertions: assertions.length,
      limit: CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions
    });
  }
  if (new Set(assertions.map((assertion) => assertion.id)).size !== assertions.length) {
    fail(context.invalidCode, "projection.assertions contain duplicate IDs");
  }
  const evidenceRefs = assertions.reduce(
    (total, assertion) => total + assertion.sourceRefs.length,
    0
  );
  if (evidenceRefs > CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs) {
    fail("BUDGET_EXCEEDED", "projection exceeds the evidence-ref budget", {
      evidenceRefs,
      limit: CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs
    });
  }
  const knownEvidence = new Map<string, GraphEvidenceRef>();
  for (const assertion of assertions) {
    for (const sourceRef of assertion.sourceRefs) {
      knownEvidence.set(evidenceRefKey(sourceRef), sourceRef);
    }
  }
  const rawBasis = dataArray(
    record.timestampBasis,
    "projection.timestampBasis",
    CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs,
    context
  );
  if (
    evidenceRefs + rawBasis.length
    > CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs
  ) {
    fail("BUDGET_EXCEEDED", "projection exceeds the total evidence-ref budget", {
      evidenceRefs: evidenceRefs + rawBasis.length,
      limit: CONTINUITY_CHANGE_LIMITS.maxEvidenceRefs
    });
  }
  const timestampBasis: ContinuityProjectionTimestampBasis[] = rawBasis.map(
    (entry, index) => {
      const basisRecord = dataRecord(
        entry,
        `projection.timestampBasis[${index.toString()}]`,
        ["basis", "sourceRef"],
        ["basis", "sourceRef"],
        context
      );
      if (
        basisRecord.basis !== "source-event"
        && basisRecord.basis !== "source-observation"
      ) {
        fail(context.invalidCode, "projection.timestampBasis has an invalid basis");
      }
      const parsedRef = parseEvidenceRef(
        basisRecord.sourceRef,
        `projection.timestampBasis[${index.toString()}].sourceRef`,
        context
      );
      const exactRef = knownEvidence.get(evidenceRefKey(parsedRef));
      if (!exactRef) {
        fail(context.invalidCode, "projection.timestampBasis references unknown evidence");
      }
      return Object.freeze({
        basis: basisRecord.basis,
        sourceRef: exactRef
      });
    }
  );
  timestampBasis.sort((left, right) =>
    evidenceRefKey(left.sourceRef).localeCompare(evidenceRefKey(right.sourceRef))
  );
  if (
    new Set(timestampBasis.map((item) => evidenceRefKey(item.sourceRef))).size
    !== timestampBasis.length
  ) {
    fail(context.invalidCode, "projection.timestampBasis contains duplicates");
  }
  if (
    timestampBasis.length !== knownEvidence.size
    || timestampBasis.some((item) =>
      !knownEvidence.has(evidenceRefKey(item.sourceRef))
    )
  ) {
    fail(
      context.invalidCode,
      "projection.timestampBasis must account for every exact evidence ref"
    );
  }
  const sourceVersion = boundedText(
    record.sourceVersion,
    "projection.sourceVersion",
    71,
    context
  );
  const declaredProjectionVersion = boundedText(
    record.projectionVersion,
    "projection.projectionVersion",
    71,
    context
  );
  if (!SHA256_PATTERN.test(sourceVersion) || !SHA256_PATTERN.test(declaredProjectionVersion)) {
    fail(context.invalidCode, "projection versions must be canonical SHA-256 digests");
  }
  const projection = Object.freeze({
    schemaVersion: 1 as const,
    ruleVersion: CONTINUITY_PROJECTION_RULE_VERSION,
    scope,
    sourceVersion,
    projectionVersion: declaredProjectionVersion,
    assertions: Object.freeze(assertions),
    timestampBasis: Object.freeze(timestampBasis)
  });
  if (projectionDigest(projection) !== declaredProjectionVersion) {
    fail("INTEGRITY_MISMATCH", "projectionVersion does not bind the projection");
  }
  return projection;
}

function boundedInteger(
  value: unknown,
  label: string,
  maximum: number,
  context: ParseContext
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(context.invalidCode, `${label} must be a non-negative safe integer`);
  }
  if ((value as number) > maximum) {
    fail("BUDGET_EXCEEDED", `${label} exceeds its budget`, {
      limit: maximum,
      value: value as number
    });
  }
  return value as number;
}

function parseDiagnostics(
  value: unknown,
  assertionCount: number,
  context: ParseContext
): ContinuityChangeObservationDiagnostics {
  const record = dataRecord(
    value,
    "diagnostics",
    [
      "descriptorsInspected",
      "projectedAssertions",
      "sourceRecordsInspected",
      "stringBytesInspected"
    ],
    [
      "descriptorsInspected",
      "projectedAssertions",
      "sourceRecordsInspected",
      "stringBytesInspected"
    ],
    context
  );
  const projectedAssertions = boundedInteger(
    record.projectedAssertions,
    "diagnostics.projectedAssertions",
    CONTINUITY_CHANGE_LIMITS.maxProjectionAssertions,
    context
  );
  if (projectedAssertions !== assertionCount) {
    fail(context.invalidCode, "diagnostics.projectedAssertions must match projection");
  }
  return Object.freeze({
    descriptorsInspected: boundedInteger(
      record.descriptorsInspected,
      "diagnostics.descriptorsInspected",
      CONTINUITY_CHANGE_LIMITS.maxDescriptors,
      context
    ),
    projectedAssertions,
    sourceRecordsInspected: boundedInteger(
      record.sourceRecordsInspected,
      "diagnostics.sourceRecordsInspected",
      CONTINUITY_CHANGE_LIMITS.maxSourceRecords,
      context
    ),
    stringBytesInspected: boundedInteger(
      record.stringBytesInspected,
      "diagnostics.stringBytesInspected",
      CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes,
      context
    )
  });
}

function parseBody(
  value: unknown,
  context: ParseContext
): Omit<ContinuityObservationReceipt, "receiptId"> {
  const record = dataRecord(
    value,
    context.invalidCode === "INVALID_INPUT" ? "observation input" : "observation receipt",
    context.invalidCode === "INVALID_INPUT"
      ? ["schemaVersion", "authority", "observedAt", "projection", "diagnostics"]
      : [
          "schemaVersion",
          "formatVersion",
          "authority",
          "observedAt",
          "projection",
          "diagnostics",
          "receiptId"
        ],
    context.invalidCode === "INVALID_INPUT"
      ? ["schemaVersion", "authority", "observedAt", "projection", "diagnostics"]
      : [
          "schemaVersion",
          "formatVersion",
          "authority",
          "observedAt",
          "projection",
          "diagnostics",
          "receiptId"
        ],
    context
  );
  if (record.schemaVersion !== 1) {
    fail(context.invalidCode, "observation schemaVersion must be 1");
  }
  if (
    context.invalidCode === "INVALID_RECEIPT"
    && record.formatVersion !== CONTINUITY_OBSERVATION_FORMAT_VERSION
  ) {
    fail("INVALID_RECEIPT", "observation formatVersion is not supported");
  }
  if (record.authority !== "caller-declared-observation") {
    fail(context.invalidCode, "observation authority is not supported");
  }
  const projection = parseProjection(record.projection, context);
  return Object.freeze({
    schemaVersion: 1 as const,
    formatVersion: CONTINUITY_OBSERVATION_FORMAT_VERSION,
    authority: "caller-declared-observation" as const,
    observedAt: canonicalInstant(record.observedAt, "observedAt", context),
    projection,
    diagnostics: parseDiagnostics(
      record.diagnostics,
      projection.assertions.length,
      context
    )
  });
}

function assertReceiptBytes(receipt: ContinuityObservationReceipt): void {
  const bytes = utf8Bytes(canonicalJson(receipt));
  if (bytes > CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes) {
    fail("BUDGET_EXCEEDED", "observation receipt exceeds its serialized byte budget", {
      bytes,
      limit: CONTINUITY_CHANGE_LIMITS.maxAggregateStringBytes
    });
  }
}

export function sealContinuityObservation(
  input: unknown
): ContinuityObservationReceipt {
  inspectPlainData(input, "observation input");
  const body = parseBody(input, { invalidCode: "INVALID_INPUT" });
  const receipt = Object.freeze({
    ...body,
    receiptId: receiptId(body)
  });
  assertReceiptBytes(receipt);
  return receipt;
}

export function captureContinuityObservation(
  input: unknown
): ContinuityObservationReceipt {
  try {
    const prepared = prepareContinuitySourceObservation(
      input,
      "observation source"
    );
    return sealContinuityObservation({
      schemaVersion: 1,
      authority: "caller-declared-observation",
      observedAt: prepared.input.sourceObservedAt,
      projection: prepared.projection,
      diagnostics: prepared.diagnostics
    });
  } catch (cause) {
    if (!(cause instanceof ContinuityChangeQueryError)) throw cause;
    throw new ContinuityObservationError(
      PREPARATION_ERROR_CODE[cause.code],
      cause.message,
      cause.details
    );
  }
}

export function verifyContinuityObservation(
  input: unknown
): ContinuityObservationReceipt {
  try {
    inspectPlainData(input, "observation receipt");
  } catch (cause) {
    if (
      cause instanceof ContinuityObservationError
      && cause.code === "INVALID_INPUT"
    ) {
      fail("INVALID_RECEIPT", cause.message, cause.details);
    }
    throw cause;
  }
  const body = parseBody(input, { invalidCode: "INVALID_RECEIPT" });
  const record = input as Record<string, unknown>;
  if (
    typeof record.receiptId !== "string"
    || !RECEIPT_ID_PATTERN.test(record.receiptId)
  ) {
    fail("INVALID_RECEIPT", "receiptId is not a supported observation receipt ID");
  }
  const receipt = Object.freeze({
    ...body,
    receiptId: record.receiptId
  });
  assertReceiptBytes(receipt);
  if (receiptId(body) !== receipt.receiptId) {
    fail("INTEGRITY_MISMATCH", "receiptId does not bind the observation receipt");
  }
  return receipt;
}

function currentComparisonObservation(
  prepared: PreparedContinuitySourceObservation
): PreparedContinuityComparisonObservation {
  return Object.freeze({
    get diagnostics() {
      return prepared.diagnostics;
    },
    get projection() {
      return prepared.projection;
    },
    scope: prepared.input.scope,
    sourceObservedAt: prepared.input.sourceObservedAt
  });
}

export function explainContinuityChangesFromReceipt(
  input: unknown
): ExplainedContinuityChangeResult {
  const envelope = receiptComparisonEnvelope(input);
  if (envelope.schemaVersion !== 1) {
    fail("INVALID_INPUT", "receipt comparison input.schemaVersion must be 1");
  }
  const receipt = verifyContinuityObservation(envelope.previousReceipt);
  try {
    const current = prepareContinuitySourceObservation(
      envelope.current,
      "current"
    );
    return comparePreparedContinuityObservations(
      preparedContinuityReceiptObservation(receipt),
      currentComparisonObservation(current),
      continuityReceiptComparisonBoundary(receipt)
    );
  } catch (cause) {
    if (!(cause instanceof ContinuityChangeQueryError)) throw cause;
    throw new ContinuityObservationError(
      COMPARISON_ERROR_CODE[cause.code],
      cause.message,
      cause.details
    );
  }
}
