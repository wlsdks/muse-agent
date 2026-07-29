import {
  LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES
} from "@muse/attunement/continuity-snapshots";

/**
 * The graph's source-boundary vocabulary.  This deliberately lives below the
 * operators: a provider capture is not a graph commit, and an unassessed read
 * must not be smuggled through a caller-declared freshness shape.
 */
const CONTROL = /[\u0000-\u001f\u007f]/u;
const GENERATION_ID = /^[a-z][a-z0-9._:-]{0,95}$/u;
const COMMIT_HASH = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_RECEIPT_ID = /^muse-local-attunement-snapshot:sha256:[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PROVIDER_ID = "muse.local-attunement-store";
const PROVIDER_VERSION = "muse.local-attunement-snapshot-provider.v1";

export type GraphSnapshotProvenanceV1 =
  | Readonly<{
      readonly authority: "caller-declared-read-snapshot";
      readonly generationId: string;
      readonly commitSequence: number;
      readonly commitHash: string;
    }>
  | Readonly<{
      readonly authority: "receipt-integrity-only";
      readonly kind: "process-local-provider-capture";
      readonly providerReceiptId: string;
      readonly providerId: "muse.local-attunement-store";
      readonly providerVersion: "muse.local-attunement-snapshot-provider.v1";
      readonly stateDigest: string;
      readonly normalizedStateBytes: number;
      readonly captureCompletedAt: string;
      readonly mintVerification: "verified-in-composing-process";
      readonly mintVerificationSurvivesSerialization: false;
    }>;

export type GraphDeclaredFreshnessV1 =
  | Readonly<{
      readonly status: "fresh" | "stale";
      readonly observedAt: string;
      readonly assessedAt: string;
    }>
  | Readonly<{
      readonly status: "rebuilding" | "unavailable";
      readonly reasonId:
        | "corrupt-snapshot"
        | "future-version"
        | "incomplete-rebuild"
        | "caller-unavailable";
    }>
  | Readonly<{
      readonly status: "unassessed";
      readonly reasonId: "single-read-no-head-revalidation";
    }>;

export type GraphSnapshotProvenanceErrorCode =
  | "INVALID_SNAPSHOT"
  | "INVALID_FRESHNESS"
  | "INVALID_PAIRING";
export type GraphSnapshotProvenanceErrorReason =
  | "invalid-container"
  | "invalid-field-set"
  | "invalid-literal"
  | "invalid-string"
  | "invalid-safe-integer"
  | "invalid-instant"
  | "invalid-order"
  | "invalid-id"
  | "invalid-digest"
  | "snapshot-freshness-mismatch";

export class GraphSnapshotProvenanceError extends Error {
  readonly code: GraphSnapshotProvenanceErrorCode;
  readonly details: Readonly<{ readonly reason: GraphSnapshotProvenanceErrorReason; readonly path: string }>;

  constructor(
    code: GraphSnapshotProvenanceErrorCode,
    reason: GraphSnapshotProvenanceErrorReason,
    path: string
  ) {
    super("graph-snapshot-provenance-invalid");
    this.name = "GraphSnapshotProvenanceError";
    this.code = code;
    this.details = Object.freeze({ reason, path: path.slice(0, 512) });
    delete (this as { stack?: unknown }).stack;
    for (const key of ["message", "name", "code", "details"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: key === "code" || key === "details",
        value: this[key],
        writable: false
      });
    }
    Object.freeze(this);
  }
}

function fail(
  code: GraphSnapshotProvenanceErrorCode,
  reason: GraphSnapshotProvenanceErrorReason,
  path: string
): never {
  throw new GraphSnapshotProvenanceError(code, reason, path);
}

function child(path: string, key: string): string {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function ordinaryRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  code: "INVALID_SNAPSHOT" | "INVALID_FRESHNESS"
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, "invalid-container", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, "invalid-container", path);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) =>
      typeof key === "string" && !required.includes(key) && !optional.includes(key)
    )
  ) {
    fail(code, "invalid-field-set", path);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(code, "invalid-container", path);
    }
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  path: string,
  maximum: number,
  code: "INVALID_SNAPSHOT" | "INVALID_FRESHNESS"
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maximum
    || CONTROL.test(value)
  ) {
    fail(code, "invalid-string", path);
  }
  return value;
}

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("INVALID_SNAPSHOT", "invalid-safe-integer", path);
  }
  return value as number;
}

function instant(
  value: unknown,
  path: string,
  code: "INVALID_SNAPSHOT" | "INVALID_FRESHNESS"
): string {
  const output = text(value, path, 64, code);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(output)
    || Number.isNaN(Date.parse(output))
    || new Date(output).toISOString() !== output
  ) {
    fail(code, "invalid-instant", path);
  }
  return output;
}

function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, value)) as Readonly<T>;
}

export function parseGraphSnapshotProvenance(
  input: unknown,
  path: string
): GraphSnapshotProvenanceV1 {
  const root = ordinaryRecord(input, ["authority"], [
    "generationId", "commitSequence", "commitHash", "kind", "providerReceiptId",
    "providerId", "providerVersion", "stateDigest", "normalizedStateBytes",
    "captureCompletedAt", "mintVerification", "mintVerificationSurvivesSerialization"
  ], path, "INVALID_SNAPSHOT");
  if (root.authority === "caller-declared-read-snapshot") {
    const exact = ordinaryRecord(input, ["authority", "generationId", "commitSequence", "commitHash"], [], path, "INVALID_SNAPSHOT");
    const generationId = text(exact.generationId, child(path, "generationId"), 96, "INVALID_SNAPSHOT");
    if (!GENERATION_ID.test(generationId)) fail("INVALID_SNAPSHOT", "invalid-id", child(path, "generationId"));
    const commitHash = text(exact.commitHash, child(path, "commitHash"), 71, "INVALID_SNAPSHOT");
    if (!COMMIT_HASH.test(commitHash)) fail("INVALID_SNAPSHOT", "invalid-digest", child(path, "commitHash"));
    return freezeRecord({ authority: "caller-declared-read-snapshot" as const, generationId, commitSequence: safeInteger(exact.commitSequence, child(path, "commitSequence")), commitHash });
  }
  if (root.authority !== "receipt-integrity-only") {
    fail("INVALID_SNAPSHOT", "invalid-literal", child(path, "authority"));
  }
  const exact = ordinaryRecord(input, [
    "authority", "kind", "providerReceiptId", "providerId", "providerVersion", "stateDigest",
    "normalizedStateBytes", "captureCompletedAt", "mintVerification", "mintVerificationSurvivesSerialization"
  ], [], path, "INVALID_SNAPSHOT");
  if (
    exact.kind !== "process-local-provider-capture"
    || exact.providerId !== PROVIDER_ID
    || exact.providerVersion !== PROVIDER_VERSION
    || exact.mintVerification !== "verified-in-composing-process"
    || exact.mintVerificationSurvivesSerialization !== false
  ) fail("INVALID_SNAPSHOT", "invalid-literal", path);
  const providerReceiptId = text(exact.providerReceiptId, child(path, "providerReceiptId"), 128, "INVALID_SNAPSHOT");
  if (!PROVIDER_RECEIPT_ID.test(providerReceiptId)) fail("INVALID_SNAPSHOT", "invalid-id", child(path, "providerReceiptId"));
  const stateDigest = text(exact.stateDigest, child(path, "stateDigest"), 71, "INVALID_SNAPSHOT");
  if (!DIGEST.test(stateDigest)) fail("INVALID_SNAPSHOT", "invalid-digest", child(path, "stateDigest"));
  return freezeRecord({
    authority: "receipt-integrity-only" as const,
    kind: "process-local-provider-capture" as const,
    providerReceiptId,
    providerId: PROVIDER_ID as "muse.local-attunement-store",
    providerVersion: PROVIDER_VERSION as "muse.local-attunement-snapshot-provider.v1",
    stateDigest,
    normalizedStateBytes: (() => {
      const bytes = safeInteger(
        exact.normalizedStateBytes,
        child(path, "normalizedStateBytes")
      );
      if (bytes > LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES) {
        fail(
          "INVALID_SNAPSHOT",
          "invalid-safe-integer",
          child(path, "normalizedStateBytes")
        );
      }
      return bytes;
    })(),
    captureCompletedAt: instant(exact.captureCompletedAt, child(path, "captureCompletedAt"), "INVALID_SNAPSHOT"),
    mintVerification: "verified-in-composing-process" as const,
    mintVerificationSurvivesSerialization: false as const
  });
}

export function parseGraphDeclaredFreshness(
  input: unknown,
  path: string
): GraphDeclaredFreshnessV1 {
  const root = ordinaryRecord(input, ["status"], ["observedAt", "assessedAt", "reasonId"], path, "INVALID_FRESHNESS");
  if (root.status === "fresh" || root.status === "stale") {
    const exact = ordinaryRecord(input, ["status", "observedAt", "assessedAt"], [], path, "INVALID_FRESHNESS");
    const observedAt = instant(exact.observedAt, child(path, "observedAt"), "INVALID_FRESHNESS");
    const assessedAt = instant(exact.assessedAt, child(path, "assessedAt"), "INVALID_FRESHNESS");
    if (Date.parse(assessedAt) < Date.parse(observedAt)) {
      fail("INVALID_FRESHNESS", "invalid-order", child(path, "assessedAt"));
    }
    return freezeRecord({ status: root.status, observedAt, assessedAt });
  }
  if (root.status === "rebuilding" || root.status === "unavailable") {
    const exact = ordinaryRecord(input, ["status", "reasonId"], [], path, "INVALID_FRESHNESS");
    if (exact.reasonId !== "corrupt-snapshot" && exact.reasonId !== "future-version" && exact.reasonId !== "incomplete-rebuild" && exact.reasonId !== "caller-unavailable") {
      fail("INVALID_FRESHNESS", "invalid-literal", child(path, "reasonId"));
    }
    return freezeRecord({
      status: root.status,
      reasonId: exact.reasonId as "corrupt-snapshot" | "future-version" | "incomplete-rebuild" | "caller-unavailable"
    });
  }
  if (root.status === "unassessed") {
    const exact = ordinaryRecord(input, ["status", "reasonId"], [], path, "INVALID_FRESHNESS");
    if (exact.reasonId !== "single-read-no-head-revalidation") fail("INVALID_FRESHNESS", "invalid-literal", child(path, "reasonId"));
    return freezeRecord({ status: "unassessed" as const, reasonId: "single-read-no-head-revalidation" as const });
  }
  fail("INVALID_FRESHNESS", "invalid-literal", child(path, "status"));
}

export function assertGraphSnapshotFreshnessPair(
  snapshot: GraphSnapshotProvenanceV1,
  freshness: GraphDeclaredFreshnessV1,
  _snapshotPath: string,
  freshnessPath: string
): void {
  const valid = snapshot.authority === "caller-declared-read-snapshot"
    ? freshness.status !== "unassessed"
    : freshness.status === "unassessed";
  if (!valid) {
    fail("INVALID_PAIRING", "snapshot-freshness-mismatch", freshnessPath);
  }
}
