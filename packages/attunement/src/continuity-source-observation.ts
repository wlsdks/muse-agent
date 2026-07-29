import { createHash } from "node:crypto";

import {
  ContinuitySourceProjectionError,
  parseContinuitySourceProjection,
  projectContinuityPackSources,
  type ContinuitySourceProjection
} from "./continuity-source-projection.js";
import {
  CONTINUITY_TEMPORAL_RULE_VERSION,
  evaluateContinuityTemporalState
} from "./continuity-temporal-state.js";

export const CONTINUITY_SOURCE_OBSERVATION_FORMAT_VERSION =
  "muse.continuity-source-observation.v1" as const;

export const CONTINUITY_SOURCE_OBSERVATION_LIMITS = Object.freeze({
  maxObservedAtBytes: 128,
  maxReceiptBytes: 1_000_000
});

const HASH_DOMAIN =
  "muse.attunement.continuity-source-observation.v1\0";
const RECEIPT_ID_PREFIX =
  "muse-continuity-source-observation:v1:sha256:";
const RECEIPT_ID_PATTERN =
  /^muse-continuity-source-observation:v1:sha256:[0-9a-f]{64}$/u;

export type ContinuitySourceObservationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RECEIPT"
  | "BUDGET_EXCEEDED"
  | "TEMPORAL_INCOHERENCE"
  | "INTEGRITY_MISMATCH";

export class ContinuitySourceObservationError extends Error {
  readonly code: ContinuitySourceObservationErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuitySourceObservationErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuitySourceObservationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ContinuitySourceObservationReceipt {
  readonly schemaVersion: 1;
  readonly formatVersion:
    typeof CONTINUITY_SOURCE_OBSERVATION_FORMAT_VERSION;
  readonly authority: "caller-declared-observation";
  readonly temporalRuleVersion: typeof CONTINUITY_TEMPORAL_RULE_VERSION;
  readonly observedAt: string;
  readonly projection: ContinuitySourceProjection;
  readonly receiptId: string;
}

type InvalidCode = "INVALID_INPUT" | "INVALID_RECEIPT";

type ReceiptBody = Omit<ContinuitySourceObservationReceipt, "receiptId">;

function fail(
  code: ContinuitySourceObservationErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuitySourceObservationError(code, message, details);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function shallowDataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
  invalidCode: InvalidCode
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(invalidCode, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(invalidCode, `${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail(invalidCode, `${label} must not contain symbol properties`);
  }
  const keys = ownKeys as string[];
  if (keys.some((key) => !allowed.includes(key))) {
    fail(invalidCode, `${label} contains an unknown field`);
  }
  if (required.some((key) => !keys.includes(key))) {
    fail(invalidCode, `${label} is missing a required field`);
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      fail(invalidCode, `${label} must contain only data properties`);
    }
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function canonicalObservedAt(
  value: unknown,
  invalidCode: InvalidCode
): string {
  if (typeof value !== "string") {
    fail(invalidCode, "observedAt must be a parseable instant");
  }
  const bytes = utf8Bytes(value);
  if (bytes > CONTINUITY_SOURCE_OBSERVATION_LIMITS.maxObservedAtBytes) {
    fail("BUDGET_EXCEEDED", "observedAt exceeds its byte budget", {
      bytes,
      limit: CONTINUITY_SOURCE_OBSERVATION_LIMITS.maxObservedAtBytes
    });
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    fail(invalidCode, "observedAt must be a parseable instant");
  }
  return instant.toISOString();
}

function mapProjectionError(
  cause: ContinuitySourceProjectionError,
  invalidCode: InvalidCode
): never {
  throw new ContinuitySourceObservationError(
    cause.code === "BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : invalidCode,
    cause.message,
    cause.details
  );
}

function captureProjection(pack: unknown): ContinuitySourceProjection {
  try {
    return projectContinuityPackSources(pack);
  } catch (cause) {
    if (cause instanceof ContinuitySourceProjectionError) {
      mapProjectionError(cause, "INVALID_INPUT");
    }
    throw cause;
  }
}

function parseProjection(value: unknown): ContinuitySourceProjection {
  try {
    return parseContinuitySourceProjection(value);
  } catch (cause) {
    if (cause instanceof ContinuitySourceProjectionError) {
      mapProjectionError(cause, "INVALID_RECEIPT");
    }
    throw cause;
  }
}

function assertTemporalCoherence(
  projection: ContinuitySourceProjection,
  observedAt: string
): void {
  const observedAtMs = Date.parse(observedAt);
  for (let index = 0; index < projection.evidence.length; index += 1) {
    const artifact = projection.evidence[index]?.artifact;
    if (!artifact) continue;
    const evaluation = evaluateContinuityTemporalState(
      artifact,
      observedAtMs
    );
    if (!evaluation.coherent) {
      fail(
        "TEMPORAL_INCOHERENCE",
        "continuity source projection has incoherent derived temporal state",
        {
          evidenceIndex: index,
          field: evaluation.field ?? "unknown"
        }
      );
    }
  }
}

function body(
  observedAt: string,
  projection: ContinuitySourceProjection
): ReceiptBody {
  return Object.freeze({
    schemaVersion: 1 as const,
    formatVersion: CONTINUITY_SOURCE_OBSERVATION_FORMAT_VERSION,
    authority: "caller-declared-observation" as const,
    temporalRuleVersion: CONTINUITY_TEMPORAL_RULE_VERSION,
    observedAt,
    projection
  });
}

function receiptId(value: ReceiptBody): string {
  const digest = createHash("sha256")
    .update(HASH_DOMAIN, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
  return `${RECEIPT_ID_PREFIX}${digest}`;
}

function assertReceiptBytes(
  receipt: ContinuitySourceObservationReceipt
): void {
  const bytes = utf8Bytes(JSON.stringify(receipt));
  if (bytes > CONTINUITY_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes) {
    fail("BUDGET_EXCEEDED", "source observation receipt exceeds its byte budget", {
      bytes,
      limit: CONTINUITY_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes
    });
  }
}

export function captureContinuitySourceObservation(
  input: unknown
): ContinuitySourceObservationReceipt {
  const record = shallowDataRecord(
    input,
    "source observation input",
    ["observedAt", "pack"],
    ["observedAt", "pack"],
    "INVALID_INPUT"
  );
  const observedAt = canonicalObservedAt(record.observedAt, "INVALID_INPUT");
  const projection = captureProjection(record.pack);
  assertTemporalCoherence(projection, observedAt);
  const receiptBody = body(observedAt, projection);
  const receipt = Object.freeze({
    ...receiptBody,
    receiptId: receiptId(receiptBody)
  });
  assertReceiptBytes(receipt);
  return receipt;
}

export function verifyContinuitySourceObservation(
  input: unknown
): ContinuitySourceObservationReceipt {
  const record = shallowDataRecord(
    input,
    "source observation receipt",
    [
      "schemaVersion",
      "formatVersion",
      "authority",
      "temporalRuleVersion",
      "observedAt",
      "projection",
      "receiptId"
    ],
    [
      "schemaVersion",
      "formatVersion",
      "authority",
      "temporalRuleVersion",
      "observedAt",
      "projection",
      "receiptId"
    ],
    "INVALID_RECEIPT"
  );
  if (record.schemaVersion !== 1) {
    fail("INVALID_RECEIPT", "source observation schemaVersion must be 1");
  }
  if (record.formatVersion !== CONTINUITY_SOURCE_OBSERVATION_FORMAT_VERSION) {
    fail("INVALID_RECEIPT", "source observation formatVersion is not supported");
  }
  if (record.authority !== "caller-declared-observation") {
    fail("INVALID_RECEIPT", "source observation authority is not supported");
  }
  if (record.temporalRuleVersion !== CONTINUITY_TEMPORAL_RULE_VERSION) {
    fail(
      "INVALID_RECEIPT",
      "source observation temporalRuleVersion is not supported"
    );
  }
  if (
    typeof record.receiptId !== "string"
    || !RECEIPT_ID_PATTERN.test(record.receiptId)
  ) {
    fail("INVALID_RECEIPT", "receiptId is not a supported source observation ID");
  }
  const observedAt = canonicalObservedAt(record.observedAt, "INVALID_RECEIPT");
  const projection = parseProjection(record.projection);
  assertTemporalCoherence(projection, observedAt);
  const receiptBody = body(observedAt, projection);
  const receipt = Object.freeze({
    ...receiptBody,
    receiptId: record.receiptId
  });
  assertReceiptBytes(receipt);
  if (receiptId(receiptBody) !== receipt.receiptId) {
    fail(
      "INTEGRITY_MISMATCH",
      "receiptId does not bind the source observation receipt"
    );
  }
  return receipt;
}
