import { createHash } from "node:crypto";

import type { ArtifactReference } from "@muse/attunement";
import {
  ContinuityScopedSourceObservationError,
  verifyScopedContinuitySourceObservation,
  type ContinuityScopedSourceObservationReceipt
} from "@muse/attunement/continuity-source-observations";

import {
  ContinuityObservationError,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import { continuitySourceGraphPairMatches } from "./continuity-source-graph-binding.js";

export const CONTINUITY_RESUME_BOUNDARY_VERSION =
  "muse.continuity-resume-boundary.v1" as const;
export const CONTINUITY_RESUME_BOUNDARY_LIMITS = Object.freeze({
  maxArtifactIdBytes: 16_384,
  maxDepth: 12,
  maxDescriptors: 32_768,
  maxReceiptBytes: 100_000,
  maxSourceIdCharacters: 128,
  maxStringBytes: 1_000_000,
  maxThreadIdBytes: 512
});
export const BOUNDARY_ID_PREFIX =
  "muse-continuity-resume-boundary:v1:sha256:" as const;

const AUTHORITY = "caller-declared-resume-boundary" as const;
const HASH_DOMAIN = "muse.attunement.continuity-resume-boundary.v1\0";
const BOUNDARY_ID_PATTERN =
  /^muse-continuity-resume-boundary:v1:sha256:[a-f0-9]{64}$/u;
const BOUNDARY_ID_PLACEHOLDER = `${BOUNDARY_ID_PREFIX}${"0".repeat(64)}`;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const GRAPH_VERSION_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CANONICAL_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type ContinuityResumeBoundaryErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RECEIPT"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_MISMATCH"
  | "BUDGET_EXCEEDED"
  | "INTEGRITY_MISMATCH"
  | "INTERNAL_POSTCONDITION_FAILED";

export class ContinuityResumeBoundaryError extends Error {
  readonly code: ContinuityResumeBoundaryErrorCode;
  readonly details: Readonly<{ path: string; reason: string }>;

  constructor(
    code: ContinuityResumeBoundaryErrorCode,
    path: string,
    reason: string
  ) {
    super("Continuity resume boundary operation failed");
    this.name = "ContinuityResumeBoundaryError";
    this.code = code;
    this.details = Object.freeze({
      path: boundedDetail(path),
      reason: boundedDetail(reason)
    });
    Object.freeze(this);
  }
}

export interface ContinuityResumeBoundary {
  readonly schemaVersion: 1;
  readonly boundaryVersion: typeof CONTINUITY_RESUME_BOUNDARY_VERSION;
  readonly authority: typeof AUTHORITY;
  readonly scope: {
    readonly sourceId: string;
    readonly threadId: string;
  };
  readonly observedAt: string;
  readonly sourceObservationReceiptId: string;
  readonly graphObservationReceiptId: string;
  readonly graphSourceVersion: string;
  readonly graphProjectionVersion: string;
  readonly previousNextStep: ArtifactReference & {
    readonly artifactType: "task";
    readonly providerId: "local";
    readonly role: "next-step";
  };
  readonly boundaryId: string;
}

export interface VerifiedContinuityResumeBoundaryDependencies {
  readonly boundary: ContinuityResumeBoundary;
  readonly previousSourceObservationReceipt:
    ContinuityScopedSourceObservationReceipt;
  readonly previousGraphObservationReceipt: ContinuityObservationReceipt;
}

type BoundaryBody = Omit<ContinuityResumeBoundary, "boundaryId">;
type InvalidCode = "INVALID_INPUT" | "INVALID_RECEIPT";
type DataRecord = Readonly<Record<string, unknown>>;

function boundedDetail(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= 256) return value;
  return new TextDecoder().decode(bytes.slice(0, 256));
}

function fail(
  code: ContinuityResumeBoundaryErrorCode,
  path: string,
  reason: string
): never {
  throw new ContinuityResumeBoundaryError(code, path, reason);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isWellFormed(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u
    .test(value);
}

function shallowRecord(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
  invalidCode: InvalidCode
): DataRecord {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(invalidCode, path, "must be an ordinary or null-prototype record");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(invalidCode, path, "must be an ordinary or null-prototype record");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length
      || ownKeys.some((key) => typeof key !== "string")
      || !(ownKeys as string[]).every((key) => expectedKeys.includes(key))
    ) {
      fail(invalidCode, path, "must contain exactly the expected string fields");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        fail(invalidCode, path, "must contain only data properties");
      }
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch (cause) {
    if (cause instanceof ContinuityResumeBoundaryError) throw cause;
    fail(invalidCode, path, "could not be safely inspected");
  }
}

function inspectWellFormedTree(
  value: unknown,
  path: string,
  allowAliases: boolean,
  invalidCode: InvalidCode
): void {
  const active = new WeakSet<object>();
  const seen = new WeakSet<object>();
  let descriptorsInspected = 0;
  let stringBytesInspected = 0;

  const countString = (text: string, stringPath: string): void => {
    if (!isWellFormed(text)) {
      fail(invalidCode, stringPath, "contains a non-well-formed string");
    }
    stringBytesInspected += utf8Bytes(text);
    if (
      stringBytesInspected
      > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxStringBytes
    ) {
      fail("BUDGET_EXCEEDED", path, "aggregate string bytes exceed the inspection budget");
    }
  };

  const visit = (item: unknown, itemPath: string, depth: number): void => {
    if (typeof item === "string") {
      countString(item, itemPath);
      return;
    }
    if (typeof item !== "object" || item === null) return;
    if (depth > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxDepth) {
      fail("BUDGET_EXCEEDED", path, "object depth exceeds the inspection budget");
    }
    if (active.has(item)) {
      fail(invalidCode, itemPath, "contains a cycle");
    }
    if (seen.has(item)) {
      if (allowAliases) return;
      fail(invalidCode, itemPath, "contains an object alias");
    }

    active.add(item);
    seen.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== "string")) {
        fail(invalidCode, itemPath, "contains a symbol property");
      }
      const descriptors = new Map<string, PropertyDescriptor>();
      for (const key of keys as string[]) {
        countString(key, itemPath);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor)) {
          fail(invalidCode, itemPath, "contains a non-data property");
        }
        descriptors.set(key, descriptor);
      }
      descriptorsInspected += descriptors.size;
      if (
        descriptorsInspected
        > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxDescriptors
      ) {
        fail("BUDGET_EXCEEDED", path, "descriptors exceed the inspection budget");
      }
      for (const descriptor of descriptors.values()) {
        visit(descriptor.value, itemPath, depth + 1);
      }
    } finally {
      active.delete(item);
    }
  };

  try {
    visit(value, path, 0);
  } catch (cause) {
    if (cause instanceof ContinuityResumeBoundaryError) throw cause;
    fail(invalidCode, path, "could not be safely inspected");
  }
}

function exactCanonicalInstant(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || !CANONICAL_INSTANT_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail("INVALID_RECEIPT", path, "must be a canonical UTC instant");
  }
  return value;
}

function bodyFromValues(values: {
  readonly scope: { readonly sourceId: string; readonly threadId: string };
  readonly observedAt: string;
  readonly sourceObservationReceiptId: string;
  readonly graphObservationReceiptId: string;
  readonly graphSourceVersion: string;
  readonly graphProjectionVersion: string;
  readonly previousNextStep: ContinuityResumeBoundary["previousNextStep"];
}): BoundaryBody {
  return Object.freeze({
    schemaVersion: 1 as const,
    boundaryVersion: CONTINUITY_RESUME_BOUNDARY_VERSION,
    authority: AUTHORITY,
    scope: Object.freeze({
      sourceId: values.scope.sourceId,
      threadId: values.scope.threadId
    }),
    observedAt: values.observedAt,
    sourceObservationReceiptId: values.sourceObservationReceiptId,
    graphObservationReceiptId: values.graphObservationReceiptId,
    graphSourceVersion: values.graphSourceVersion,
    graphProjectionVersion: values.graphProjectionVersion,
    previousNextStep: Object.freeze({
      artifactId: values.previousNextStep.artifactId,
      artifactType: "task" as const,
      providerId: "local" as const,
      role: "next-step" as const
    })
  });
}

function boundaryId(body: BoundaryBody): string {
  const digest = createHash("sha256")
    .update(HASH_DOMAIN, "utf8")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return `${BOUNDARY_ID_PREFIX}${digest}`;
}

function assertFieldContracts(
  body: BoundaryBody,
  invalidCode: "INVALID_RECEIPT" | "INTERNAL_POSTCONDITION_FAILED"
): void {
  if (!SOURCE_ID_PATTERN.test(body.scope.sourceId)) {
    fail(invalidCode, "boundary.scope.sourceId", "must be a logical source identifier");
  }
  if (
    body.scope.sourceId.length
    > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxSourceIdCharacters
  ) {
    fail("BUDGET_EXCEEDED", "boundary.scope.sourceId", "exceeds its character budget");
  }
  if (body.scope.threadId.length === 0) {
    fail(invalidCode, "boundary.scope.threadId", "must be non-empty");
  }
  if (
    utf8Bytes(body.scope.threadId)
    > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxThreadIdBytes
  ) {
    fail("BUDGET_EXCEEDED", "boundary.scope.threadId", "exceeds its UTF-8 byte budget");
  }
  if (
    !CANONICAL_INSTANT_PATTERN.test(body.observedAt)
    || Number.isNaN(Date.parse(body.observedAt))
    || new Date(body.observedAt).toISOString() !== body.observedAt
  ) {
    fail(invalidCode, "boundary.observedAt", "must be a canonical UTC instant");
  }
  if (
    typeof body.sourceObservationReceiptId !== "string"
    || body.sourceObservationReceiptId.length === 0
  ) {
    fail(invalidCode, "boundary.sourceObservationReceiptId", "must be non-empty text");
  }
  if (
    typeof body.graphObservationReceiptId !== "string"
    || body.graphObservationReceiptId.length === 0
  ) {
    fail(invalidCode, "boundary.graphObservationReceiptId", "must be non-empty text");
  }
  if (!GRAPH_VERSION_PATTERN.test(body.graphSourceVersion)) {
    fail(invalidCode, "boundary.graphSourceVersion", "must be a lowercase SHA-256 version");
  }
  if (!GRAPH_VERSION_PATTERN.test(body.graphProjectionVersion)) {
    fail(invalidCode, "boundary.graphProjectionVersion", "must be a lowercase SHA-256 version");
  }
  if (body.previousNextStep.artifactId.length === 0) {
    fail(invalidCode, "boundary.previousNextStep.artifactId", "must be non-empty");
  }
  if (
    utf8Bytes(body.previousNextStep.artifactId)
    > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxArtifactIdBytes
  ) {
    fail("BUDGET_EXCEEDED", "boundary.previousNextStep.artifactId", "exceeds its UTF-8 byte budget");
  }
}

function assertReceiptBytes(body: BoundaryBody): void {
  const bytes = utf8Bytes(JSON.stringify({
    ...body,
    boundaryId: BOUNDARY_ID_PLACEHOLDER
  }));
  if (bytes > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxReceiptBytes) {
    fail("BUDGET_EXCEEDED", "boundary", "exceeds its canonical receipt byte budget");
  }
}

function verifyPortableBoundary(input: unknown): ContinuityResumeBoundary {
  const record = shallowRecord(input, "boundary", [
    "schemaVersion",
    "boundaryVersion",
    "authority",
    "scope",
    "observedAt",
    "sourceObservationReceiptId",
    "graphObservationReceiptId",
    "graphSourceVersion",
    "graphProjectionVersion",
    "previousNextStep",
    "boundaryId"
  ], "INVALID_RECEIPT");
  inspectWellFormedTree(input, "boundary", false, "INVALID_RECEIPT");
  if (record.schemaVersion !== 1) {
    fail("INVALID_RECEIPT", "boundary.schemaVersion", "must be 1");
  }
  if (record.boundaryVersion !== CONTINUITY_RESUME_BOUNDARY_VERSION) {
    fail("INVALID_RECEIPT", "boundary.boundaryVersion", "is unsupported");
  }
  if (record.authority !== AUTHORITY) {
    fail("INVALID_RECEIPT", "boundary.authority", "is unsupported");
  }
  const scope = shallowRecord(record.scope, "boundary.scope", [
    "sourceId",
    "threadId"
  ], "INVALID_RECEIPT");
  const nextStep = shallowRecord(
    record.previousNextStep,
    "boundary.previousNextStep",
    ["artifactId", "artifactType", "providerId", "role"],
    "INVALID_RECEIPT"
  );
  if (
    typeof scope.sourceId !== "string"
    || typeof scope.threadId !== "string"
    || typeof record.sourceObservationReceiptId !== "string"
    || typeof record.graphObservationReceiptId !== "string"
    || typeof record.graphSourceVersion !== "string"
    || typeof record.graphProjectionVersion !== "string"
    || typeof nextStep.artifactId !== "string"
  ) {
    fail("INVALID_RECEIPT", "boundary", "contains a field with an unsupported type");
  }
  if (
    nextStep.artifactType !== "task"
    || nextStep.providerId !== "local"
    || nextStep.role !== "next-step"
  ) {
    fail("INVALID_RECEIPT", "boundary.previousNextStep", "must be the exact local task next-step reference");
  }
  if (
    typeof record.boundaryId !== "string"
    || !BOUNDARY_ID_PATTERN.test(record.boundaryId)
  ) {
    fail("INVALID_RECEIPT", "boundary.boundaryId", "is not a supported boundary ID");
  }
  const body = bodyFromValues({
    scope: {
      sourceId: scope.sourceId,
      threadId: scope.threadId
    },
    observedAt: exactCanonicalInstant(record.observedAt, "boundary.observedAt"),
    sourceObservationReceiptId: record.sourceObservationReceiptId,
    graphObservationReceiptId: record.graphObservationReceiptId,
    graphSourceVersion: record.graphSourceVersion,
    graphProjectionVersion: record.graphProjectionVersion,
    previousNextStep: {
      artifactId: nextStep.artifactId,
      artifactType: "task",
      providerId: "local",
      role: "next-step"
    }
  });
  assertFieldContracts(body, "INVALID_RECEIPT");
  assertReceiptBytes(body);
  const computedId = boundaryId(body);
  if (computedId !== record.boundaryId) {
    fail("INTEGRITY_MISMATCH", "boundary.boundaryId", "does not bind the canonical boundary");
  }
  const receipt = Object.freeze({ ...body, boundaryId: computedId });
  const postBody = bodyFromValues({
    scope: receipt.scope,
    observedAt: receipt.observedAt,
    sourceObservationReceiptId: receipt.sourceObservationReceiptId,
    graphObservationReceiptId: receipt.graphObservationReceiptId,
    graphSourceVersion: receipt.graphSourceVersion,
    graphProjectionVersion: receipt.graphProjectionVersion,
    previousNextStep: receipt.previousNextStep
  });
  const postDigest = createHash("sha256")
    .update("muse.attunement.continuity-resume-boundary.v1\0", "utf8")
    .update(JSON.stringify(postBody), "utf8")
    .digest("hex");
  const postId = `${BOUNDARY_ID_PREFIX}${postDigest}`;
  const postBytes = utf8Bytes(JSON.stringify({
    ...postBody,
    boundaryId: receipt.boundaryId
  }));
  if (
    postBytes > CONTINUITY_RESUME_BOUNDARY_LIMITS.maxReceiptBytes
    || postId !== receipt.boundaryId
    || JSON.stringify(postBody) !== JSON.stringify(body)
    || !Object.isFrozen(receipt)
    || !Object.isFrozen(receipt.scope)
    || !Object.isFrozen(receipt.previousNextStep)
  ) {
    fail("INTERNAL_POSTCONDITION_FAILED", "boundary", "canonical postcondition failed");
  }
  return receipt;
}

function mapDependency(cause: unknown): never {
  if (
    cause instanceof ContinuityScopedSourceObservationError
    || cause instanceof ContinuityObservationError
  ) {
    fail(
      cause.code === "BUDGET_EXCEEDED"
        ? "BUDGET_EXCEEDED"
        : "INVALID_DEPENDENCY",
      "dependency",
      cause.code === "BUDGET_EXCEEDED"
        ? "upstream dependency budget was exceeded"
        : "dependency verification failed"
    );
  }
  fail("INVALID_DEPENDENCY", "dependency", "dependency verification failed");
}

function verifyDependencies(
  sourceInput: unknown,
  graphInput: unknown
): readonly [
  ContinuityScopedSourceObservationReceipt,
  ContinuityObservationReceipt
] {
  let source: ContinuityScopedSourceObservationReceipt;
  let graph: ContinuityObservationReceipt;
  try {
    source = verifyScopedContinuitySourceObservation(sourceInput);
  } catch (cause) {
    mapDependency(cause);
  }
  try {
    graph = verifyContinuityObservation(graphInput);
  } catch (cause) {
    mapDependency(cause);
  }
  return [source, graph];
}

function buildFromVerifiedDependencies(
  source: ContinuityScopedSourceObservationReceipt,
  graph: ContinuityObservationReceipt
): ContinuityResumeBoundary {
  if (!continuitySourceGraphPairMatches(source, graph)) {
    fail("DEPENDENCY_MISMATCH", "dependency", "source and graph receipts are not an exact pair");
  }
  const resolved = source.observation.projection.nextStep;
  if (
    !resolved
    || resolved.artifactType !== "task"
    || resolved.providerId !== "local"
    || resolved.role !== "next-step"
  ) {
    fail("DEPENDENCY_MISMATCH", "dependency", "source receipt has no resolved local task next step");
  }
  const body = bodyFromValues({
    scope: source.scope,
    observedAt: source.observation.observedAt,
    sourceObservationReceiptId: source.receiptId,
    graphObservationReceiptId: graph.receiptId,
    graphSourceVersion: graph.projection.sourceVersion,
    graphProjectionVersion: graph.projection.projectionVersion,
    previousNextStep: {
      artifactId: resolved.artifactId,
      artifactType: "task",
      providerId: "local",
      role: "next-step"
    }
  });
  assertFieldContracts(body, "INTERNAL_POSTCONDITION_FAILED");
  assertReceiptBytes(body);
  const receipt = Object.freeze({ ...body, boundaryId: boundaryId(body) });
  try {
    const verified = verifyPortableBoundary(receipt);
    if (JSON.stringify(receipt) !== JSON.stringify(verified)) {
      fail("INTERNAL_POSTCONDITION_FAILED", "boundary", "finalizer changed canonical bytes");
    }
    return verified;
  } catch (cause) {
    if (
      cause instanceof ContinuityResumeBoundaryError
      && (
        cause.code === "BUDGET_EXCEEDED"
        || cause.code === "DEPENDENCY_MISMATCH"
      )
    ) {
      throw cause;
    }
    fail("INTERNAL_POSTCONDITION_FAILED", "boundary", "finalizer postverification failed");
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export function captureContinuityResumeBoundary(
  input: unknown
): ContinuityResumeBoundary {
  let record: DataRecord;
  try {
    record = shallowRecord(input, "input", [
      "previousSourceObservationReceipt",
      "previousGraphObservationReceipt"
    ], "INVALID_INPUT");
    inspectWellFormedTree(
      record.previousSourceObservationReceipt,
      "input.previousSourceObservationReceipt",
      true,
      "INVALID_INPUT"
    );
    inspectWellFormedTree(
      record.previousGraphObservationReceipt,
      "input.previousGraphObservationReceipt",
      true,
      "INVALID_INPUT"
    );
  } catch (cause) {
    if (cause instanceof ContinuityResumeBoundaryError) throw cause;
    fail("INVALID_INPUT", "input", "could not be safely inspected");
  }
  const [source, graph] = verifyDependencies(
    record.previousSourceObservationReceipt,
    record.previousGraphObservationReceipt
  );
  return buildFromVerifiedDependencies(source, graph);
}

export function verifyContinuityResumeBoundary(
  input: unknown
): ContinuityResumeBoundary {
  try {
    return verifyPortableBoundary(input);
  } catch (cause) {
    if (cause instanceof ContinuityResumeBoundaryError) throw cause;
    fail("INVALID_RECEIPT", "boundary", "could not be safely inspected");
  }
}

export function verifyContinuityResumeBoundaryWithDependencies(
  input: unknown
): VerifiedContinuityResumeBoundaryDependencies {
  let record: DataRecord;
  try {
    record = shallowRecord(input, "input", [
      "boundary",
      "previousSourceObservationReceipt",
      "previousGraphObservationReceipt"
    ], "INVALID_INPUT");
  } catch (cause) {
    if (cause instanceof ContinuityResumeBoundaryError) throw cause;
    fail("INVALID_INPUT", "input", "could not be safely inspected");
  }
  const boundary = verifyContinuityResumeBoundary(record.boundary);
  try {
    inspectWellFormedTree(
      record.previousSourceObservationReceipt,
      "input.previousSourceObservationReceipt",
      true,
      "INVALID_INPUT"
    );
    inspectWellFormedTree(
      record.previousGraphObservationReceipt,
      "input.previousGraphObservationReceipt",
      true,
      "INVALID_INPUT"
    );
  } catch (cause) {
    if (cause instanceof ContinuityResumeBoundaryError) throw cause;
    fail("INVALID_INPUT", "input", "could not be safely inspected");
  }
  const [source, graph] = verifyDependencies(
    record.previousSourceObservationReceipt,
    record.previousGraphObservationReceipt
  );
  let recomputed: ContinuityResumeBoundary;
  try {
    recomputed = buildFromVerifiedDependencies(source, graph);
  } catch (cause) {
    if (
      cause instanceof ContinuityResumeBoundaryError
      && cause.code === "INTERNAL_POSTCONDITION_FAILED"
    ) {
      throw cause;
    }
    fail("DEPENDENCY_MISMATCH", "dependency", "dependencies do not recompute the supplied boundary");
  }
  if (
    recomputed.boundaryId !== boundary.boundaryId
    || JSON.stringify(recomputed) !== JSON.stringify(boundary)
  ) {
    fail("DEPENDENCY_MISMATCH", "dependency", "dependencies do not recompute the supplied boundary");
  }
  try {
    return deepFreeze({
      boundary,
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    });
  } catch {
    fail("INTERNAL_POSTCONDITION_FAILED", "result", "deep-freeze postcondition failed");
  }
}
