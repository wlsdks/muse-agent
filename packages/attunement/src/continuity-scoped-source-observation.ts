import { createHash } from "node:crypto";

import {
  ContinuitySourceObservationError,
  captureContinuitySourceObservation,
  verifyContinuitySourceObservation,
  type ContinuitySourceObservationReceipt
} from "./continuity-source-observation.js";

export const CONTINUITY_SCOPED_SOURCE_OBSERVATION_FORMAT_VERSION =
  "muse.continuity-scoped-source-observation.v1" as const;

export const CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS = Object.freeze({
  maxReceiptBytes: 1_001_024,
  maxSourceIdCharacters: 128
});

const HASH_DOMAIN =
  "muse.attunement.continuity-scoped-source-observation.v1\0";
const RECEIPT_ID_PREFIX =
  "muse-continuity-scoped-source-observation:v1:sha256:";
const RECEIPT_ID_PATTERN =
  /^muse-continuity-scoped-source-observation:v1:sha256:[0-9a-f]{64}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const RECEIPT_ID_PLACEHOLDER = `${RECEIPT_ID_PREFIX}${"0".repeat(64)}`;

export type ContinuityScopedSourceObservationErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RECEIPT"
  | "BUDGET_EXCEEDED"
  | "INTEGRITY_MISMATCH";

export class ContinuityScopedSourceObservationError extends Error {
  readonly code: ContinuityScopedSourceObservationErrorCode;
  readonly details: Readonly<Record<string, number | string>>;

  constructor(
    code: ContinuityScopedSourceObservationErrorCode,
    message: string,
    details: Readonly<Record<string, number | string>> = {}
  ) {
    super(message);
    this.name = "ContinuityScopedSourceObservationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface ContinuityScopedSourceObservationScope {
  readonly sourceId: string;
  readonly threadId: string;
}

export interface ContinuityScopedSourceObservationReceipt {
  readonly schemaVersion: 1;
  readonly formatVersion:
    typeof CONTINUITY_SCOPED_SOURCE_OBSERVATION_FORMAT_VERSION;
  readonly authority: "caller-declared-observation";
  readonly scope: ContinuityScopedSourceObservationScope;
  readonly observation: ContinuitySourceObservationReceipt;
  readonly receiptId: string;
}

type InvalidCode = "INVALID_INPUT" | "INVALID_RECEIPT";
type ReceiptBody = Omit<ContinuityScopedSourceObservationReceipt, "receiptId">;

function fail(
  code: ContinuityScopedSourceObservationErrorCode,
  message: string,
  details: Readonly<Record<string, number | string>> = {}
): never {
  throw new ContinuityScopedSourceObservationError(code, message, details);
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

function parseScope(
  value: unknown,
  invalidCode: InvalidCode
): ContinuityScopedSourceObservationScope {
  const record = shallowDataRecord(
    value,
    "scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"],
    invalidCode
  );
  if (typeof record.sourceId !== "string") {
    fail(invalidCode, "scope.sourceId must be a logical identifier");
  }
  if (
    record.sourceId.length > CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS.maxSourceIdCharacters
  ) {
    fail("BUDGET_EXCEEDED", "scope.sourceId exceeds its character budget", {
      characters: record.sourceId.length,
      limit: CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS.maxSourceIdCharacters
    });
  }
  if (!SOURCE_ID_PATTERN.test(record.sourceId)) {
    fail(invalidCode, "scope.sourceId must be a logical identifier");
  }
  if (typeof record.threadId !== "string" || record.threadId.length === 0) {
    fail(invalidCode, "scope.threadId must be non-empty text");
  }
  return Object.freeze({
    sourceId: record.sourceId,
    threadId: record.threadId
  });
}

function body(
  scope: ContinuityScopedSourceObservationScope,
  observation: ContinuitySourceObservationReceipt
): ReceiptBody {
  return Object.freeze({
    schemaVersion: 1 as const,
    formatVersion: CONTINUITY_SCOPED_SOURCE_OBSERVATION_FORMAT_VERSION,
    authority: "caller-declared-observation" as const,
    scope,
    observation
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
  bodyValue: ReceiptBody,
  receiptIdValue: string
): void {
  const bytes = utf8Bytes(JSON.stringify({ ...bodyValue, receiptId: receiptIdValue }));
  if (bytes > CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes) {
    fail("BUDGET_EXCEEDED", "scoped source observation receipt exceeds its serialized byte budget", {
      bytes,
      limit: CONTINUITY_SCOPED_SOURCE_OBSERVATION_LIMITS.maxReceiptBytes
    });
  }
}

function assertThreadBinding(
  scope: ContinuityScopedSourceObservationScope,
  observation: ContinuitySourceObservationReceipt,
  invalidCode: InvalidCode
): void {
  if (scope.threadId !== observation.projection.thread.id) {
    fail(invalidCode, "scope.threadId must equal the source observation thread ID");
  }
}

function mapVerifiedObservationError(cause: ContinuitySourceObservationError): never {
  throw new ContinuityScopedSourceObservationError(
    cause.code === "BUDGET_EXCEEDED" ? "BUDGET_EXCEEDED" : "INVALID_RECEIPT",
    cause.message,
    cause.details
  );
}

export function captureScopedContinuitySourceObservation(
  input: unknown
): ContinuityScopedSourceObservationReceipt {
  const record = shallowDataRecord(
    input,
    "scoped source observation input",
    ["scope", "observedAt", "pack"],
    ["scope", "observedAt", "pack"],
    "INVALID_INPUT"
  );
  const scope = parseScope(record.scope, "INVALID_INPUT");
  const observation = captureContinuitySourceObservation({
    observedAt: record.observedAt,
    pack: record.pack
  });
  assertThreadBinding(scope, observation, "INVALID_INPUT");
  const receiptBody = body(scope, observation);
  assertReceiptBytes(receiptBody, RECEIPT_ID_PLACEHOLDER);
  return Object.freeze({
    ...receiptBody,
    receiptId: receiptId(receiptBody)
  });
}

export function verifyScopedContinuitySourceObservation(
  input: unknown
): ContinuityScopedSourceObservationReceipt {
  const record = shallowDataRecord(
    input,
    "scoped source observation receipt",
    ["schemaVersion", "formatVersion", "authority", "scope", "observation", "receiptId"],
    ["schemaVersion", "formatVersion", "authority", "scope", "observation", "receiptId"],
    "INVALID_RECEIPT"
  );
  if (record.schemaVersion !== 1) {
    fail("INVALID_RECEIPT", "scoped source observation schemaVersion must be 1");
  }
  if (record.formatVersion !== CONTINUITY_SCOPED_SOURCE_OBSERVATION_FORMAT_VERSION) {
    fail("INVALID_RECEIPT", "scoped source observation formatVersion is not supported");
  }
  if (record.authority !== "caller-declared-observation") {
    fail("INVALID_RECEIPT", "scoped source observation authority is not supported");
  }
  if (typeof record.receiptId !== "string" || !RECEIPT_ID_PATTERN.test(record.receiptId)) {
    fail("INVALID_RECEIPT", "receiptId is not a supported scoped source observation ID");
  }
  const scope = parseScope(record.scope, "INVALID_RECEIPT");
  let observation: ContinuitySourceObservationReceipt;
  try {
    observation = verifyContinuitySourceObservation(record.observation);
  } catch (cause) {
    if (cause instanceof ContinuitySourceObservationError) {
      mapVerifiedObservationError(cause);
    }
    throw cause;
  }
  assertThreadBinding(scope, observation, "INVALID_RECEIPT");
  const receiptBody = body(scope, observation);
  assertReceiptBytes(receiptBody, record.receiptId);
  if (receiptId(receiptBody) !== record.receiptId) {
    fail("INTEGRITY_MISMATCH", "receiptId does not bind the scoped source observation receipt");
  }
  return Object.freeze({
    ...receiptBody,
    receiptId: record.receiptId
  });
}
