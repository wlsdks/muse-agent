import { createHash } from "node:crypto";

import {
  LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES,
  verifyMintedLocalAttunementSnapshotCapture,
  type LocalAttunementSnapshotAbstentionReason,
  type LocalAttunementSnapshotAbstentionReceiptV1,
  type LocalAttunementSnapshotReceiptV1,
  type LocalAttunementSnapshotScope,
  type VerifiedMintedLocalAttunementSnapshotCapture
} from "@muse/attunement/continuity-snapshots";

import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import {
  captureContinuityObservation,
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  continuityThreadGraphRef
} from "./continuity-projection.js";
import {
  assertGraphSnapshotFreshnessPair,
  type GraphDeclaredFreshnessV1,
  type GraphSnapshotProvenanceV1
} from "./graph-snapshot-provenance.js";
import {
  compileReceiptBoundGraphEvidence,
  type ReceiptBoundGraphEvidenceV1
} from "./receipt-bound-graph-evidence.js";
import type {
  GraphAssertion,
  GraphRef
} from "./types.js";

const BINDING_RECEIPT_SPEC = Object.freeze({
  hashDomain:
    "muse.attunement-graph.provider-bound-graph-evidence-receipt.v1",
  idField: "receiptId",
  idPrefix: "muse-provider-bound-graph-evidence:sha256:"
} as const);

const BINDING_RECEIPT_ID =
  /^muse-provider-bound-graph-evidence:sha256:[0-9a-f]{64}$/u;
const PROVIDER_RECEIPT_ID =
  /^muse-local-attunement-snapshot:sha256:[0-9a-f]{64}$/u;
const OBSERVATION_RECEIPT_ID =
  /^muse-continuity-observation:v1:sha256:[0-9a-f]{64}$/u;
const GRAPH_EVIDENCE_RECEIPT_ID =
  /^muse-receipt-bound-graph-evidence-receipt:sha256:[0-9a-f]{64}$/u;
const GRAPH_ACTIVATION_EVIDENCE_ID =
  /^muse-receipt-bound-activation-evidence:sha256:[0-9a-f]{64}$/u;
const THREAD_SEED_ID = /^muse-continuity-thread:[0-9a-f]{64}$/u;
const ASSERTION_ID_SUFFIX = /:([0-9a-f]{64})$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OMITTED_DIGEST =
  /^muse-provider-bound-omitted-assertion-ids:sha256:[0-9a-f]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RAW = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET = Object.freeze({
  maxAssertions: 32,
  maxConsideredAssertions: 256,
  maxDepth: 4,
  maxEstimatedTokens: 4096,
  maxOutputBytes: 262_144,
  maxVisitedRefs: 128
} as const);

type ProviderSnapshot = Extract<
  GraphSnapshotProvenanceV1,
  { readonly kind: "process-local-provider-capture" }
>;
type ProviderFreshness = Extract<
  GraphDeclaredFreshnessV1,
  { readonly status: "unassessed" }
>;
type ProviderGraphCoverageReason =
  | "provider-unavailable"
  | "single-local-store"
  | "point-in-time-read"
  | "freshness-unassessed"
  | "source-authority-unverified"
  | "nomination-capacity-bounded"
  | "graph-settlement-abstained";

type ProviderStageCoverageReasons = readonly ["provider-unavailable"];
type GraphStageCoverageReasons =
  | readonly [
      "single-local-store",
      "point-in-time-read",
      "freshness-unassessed",
      "source-authority-unverified",
      "graph-settlement-abstained"
    ]
  | readonly [
      "single-local-store",
      "point-in-time-read",
      "freshness-unassessed",
      "source-authority-unverified",
      "nomination-capacity-bounded",
      "graph-settlement-abstained"
    ];

type BindingCoverage<Reasons extends readonly ProviderGraphCoverageReason[]> =
  Readonly<{
    readonly status: "abstained";
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly canAssertFreshness: false;
    readonly canAssertDurableProviderAuthority: false;
    readonly reasons: Reasons;
  }>;

type BindingReceiptCommon = Readonly<{
  readonly schemaVersion: 1;
  readonly receiptVersion:
    "muse.provider-bound-graph-evidence-receipt.v1";
  readonly receiptId: string;
  readonly authority: "receipt-integrity-only";
  readonly status: "abstained";
  readonly providerReceiptId: string;
  readonly providerId: "muse.local-attunement-store";
  readonly providerVersion: "muse.local-attunement-snapshot-provider.v1";
  readonly providerScope: LocalAttunementSnapshotScope;
  readonly providerCaptureCompletedAt: string;
  readonly providerFreshness: Readonly<{
    readonly status: "unassessed";
    readonly reason: "single-read-no-head-revalidation";
  }>;
  readonly mintVerification: "verified-in-composing-process";
  readonly mintVerificationSurvivesSerialization: false;
}>;

export type ProviderGraphBindingReceiptV1 =
  | BindingReceiptCommon & Readonly<{
      readonly stage: "provider";
      readonly coverage: BindingCoverage<ProviderStageCoverageReasons>;
      readonly providerAbstentionReason:
        LocalAttunementSnapshotAbstentionReason;
      readonly providerCoverageReasons:
        readonly ["no-available-provider-snapshot"];
    }>
  | BindingReceiptCommon & Readonly<{
      readonly stage: "graph-evidence";
      readonly coverage: BindingCoverage<GraphStageCoverageReasons>;
      readonly providerStateDigest: string;
      readonly providerNormalizedStateBytes: number;
      readonly graphObservationReceiptId: string;
      readonly graphObservationReceiptVersion:
        "muse.continuity-observation.v1";
      readonly graphObservationAuthority: "caller-declared-observation";
      readonly graphObservedAtSemantics:
        "provider-capture-completed-by-bound";
      readonly graphEvidenceReceiptId: string;
      readonly graphActivationEvidenceId: string;
      readonly graphActualSeed: GraphRef;
      readonly nominations: Readonly<{
        readonly core: 1;
        readonly change: number;
        readonly support: number;
        readonly omitted: number;
        readonly omittedAssertionIdsDigest: string | null;
      }>;
      readonly budget: typeof PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET;
      readonly snapshot: ProviderSnapshot;
      readonly declaredFreshness: ProviderFreshness;
    }>;

export type ProviderBoundGraphEvidenceV1 =
  | Readonly<{
      readonly status: "abstained";
      readonly stage: "provider";
      readonly providerReceipt:
        LocalAttunementSnapshotAbstentionReceiptV1;
      readonly receipt: ProviderGraphBindingReceiptV1;
    }>
  | Readonly<{
      readonly status: "abstained";
      readonly stage: "graph-evidence";
      readonly providerReceipt: LocalAttunementSnapshotReceiptV1;
      readonly graphObservationReceipt: ContinuityObservationReceipt;
      readonly graphEvidence: ReceiptBoundGraphEvidenceV1;
      readonly receipt: ProviderGraphBindingReceiptV1;
    }>;

export type ProviderBoundGraphEvidenceErrorCode =
  | "INVALID_CAPTURE"
  | "PROVIDER_BINDING_MISMATCH"
  | "GRAPH_OBSERVATION_FAILED"
  | "GRAPH_EVIDENCE_FAILED"
  | "INTERNAL_POSTCONDITION_FAILED";

export type ProviderBoundGraphEvidenceErrorReason =
  | "capture-not-minted"
  | "provider-state-byte-mismatch"
  | "provider-state-digest-mismatch"
  | "provider-state-json-invalid"
  | "graph-observation-failed"
  | "graph-observation-boundary-mismatch"
  | "core-nomination-unavailable"
  | "graph-evidence-failed"
  | "graph-evidence-boundary-mismatch"
  | "binding-receipt-postcondition-failed";

export class ProviderBoundGraphEvidenceError extends Error {
  readonly code: ProviderBoundGraphEvidenceErrorCode;
  readonly details: Readonly<{
    readonly reason: ProviderBoundGraphEvidenceErrorReason;
    readonly path: string;
  }>;

  constructor(
    code: ProviderBoundGraphEvidenceErrorCode,
    reason: ProviderBoundGraphEvidenceErrorReason,
    path: string
  ) {
    super("provider-bound-graph-evidence-failed");
    this.name = "ProviderBoundGraphEvidenceError";
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

export type ProviderGraphBindingReceiptErrorCode =
  | "INVALID_RECEIPT"
  | "INTEGRITY_MISMATCH";

export type ProviderGraphBindingReceiptErrorReason =
  | "invalid-container"
  | "invalid-field-set"
  | "invalid-literal"
  | "invalid-string"
  | "invalid-safe-integer"
  | "invalid-instant"
  | "invalid-id"
  | "invalid-digest"
  | "invalid-count-accounting"
  | "stage-field-mismatch"
  | "receipt-id-mismatch";

export class ProviderGraphBindingReceiptError extends Error {
  readonly code: ProviderGraphBindingReceiptErrorCode;
  readonly details: Readonly<{
    readonly reason: ProviderGraphBindingReceiptErrorReason;
    readonly path: string;
  }>;

  constructor(
    code: ProviderGraphBindingReceiptErrorCode,
    reason: ProviderGraphBindingReceiptErrorReason,
    path: string
  ) {
    super("provider-graph-binding-receipt-invalid");
    this.name = "ProviderGraphBindingReceiptError";
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

export type DerivedProviderGraphNominations = Readonly<{
  readonly input: readonly Readonly<{
    readonly assertionId: string;
    readonly nominationId: string;
    readonly role: "core" | "change" | "support";
  }>[];
  readonly counts: Readonly<{
    readonly core: 1;
    readonly change: number;
    readonly support: number;
    readonly omitted: number;
    readonly omittedAssertionIdsDigest: string | null;
  }>;
}>;

function bindingFail(
  code: ProviderBoundGraphEvidenceErrorCode,
  reason: ProviderBoundGraphEvidenceErrorReason,
  path: string
): never {
  throw new ProviderBoundGraphEvidenceError(code, reason, path);
}

function receiptFail(
  code: ProviderGraphBindingReceiptErrorCode,
  reason: ProviderGraphBindingReceiptErrorReason,
  path: string
): never {
  throw new ProviderGraphBindingReceiptError(code, reason, path);
}

function freezeRecord<T extends Record<string, unknown>>(
  value: T
): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
}

function freezeArray<T>(value: readonly T[]): readonly T[] {
  return Object.freeze([...value]);
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor !== undefined
        && "value" in descriptor
        && key !== "length"
      ) {
        freezeTree(descriptor.value);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stateDigest(value: string): string {
  return `sha256:${sha256Utf8(value)}`;
}

function canonicalOmittedIdsDigest(
  assertionIds: readonly string[]
): string | null {
  if (assertionIds.length === 0) return null;
  const canonicalJson = JSON.stringify({
    assertionIds,
    hashDomain:
      "muse.attunement-graph.provider-bound-omitted-assertion-ids.v1",
    schemaVersion: 1
  });
  return `muse-provider-bound-omitted-assertion-ids:sha256:${
    sha256Utf8(canonicalJson)
  }`;
}

function verifyCapture(
  capture: unknown
): VerifiedMintedLocalAttunementSnapshotCapture {
  try {
    return verifyMintedLocalAttunementSnapshotCapture(capture);
  } catch {
    bindingFail("INVALID_CAPTURE", "capture-not-minted", "/capture");
  }
}

function readAvailableState(
  capture: Extract<
    VerifiedMintedLocalAttunementSnapshotCapture,
    { readonly status: "available" }
  >
): Readonly<{ readonly state: unknown; readonly json: string }> {
  const descriptor = Object.getOwnPropertyDescriptor(
    capture,
    "normalizedStateJson"
  );
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
  ) {
    bindingFail(
      "PROVIDER_BINDING_MISMATCH",
      "provider-state-byte-mismatch",
      "/capture/normalizedStateJson"
    );
  }
  const json = descriptor.value;
  const bytes = Buffer.byteLength(json, "utf8");
  if (
    bytes > LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES
    || bytes !== capture.receipt.normalizedStateBytes
  ) {
    bindingFail(
      "PROVIDER_BINDING_MISMATCH",
      "provider-state-byte-mismatch",
      "/capture/normalizedStateJson"
    );
  }
  if (stateDigest(json) !== capture.receipt.stateDigest) {
    bindingFail(
      "PROVIDER_BINDING_MISMATCH",
      "provider-state-digest-mismatch",
      "/capture/normalizedStateJson"
    );
  }
  try {
    return freezeRecord({ json, state: JSON.parse(json) as unknown });
  } catch {
    bindingFail(
      "PROVIDER_BINDING_MISMATCH",
      "provider-state-json-invalid",
      "/capture/normalizedStateJson"
    );
  }
}

function providerSnapshot(
  receipt: LocalAttunementSnapshotReceiptV1
): ProviderSnapshot {
  return freezeRecord({
    authority: "receipt-integrity-only" as const,
    kind: "process-local-provider-capture" as const,
    providerReceiptId: receipt.receiptId,
    providerId: receipt.providerId,
    providerVersion: receipt.providerVersion,
    stateDigest: receipt.stateDigest,
    normalizedStateBytes: receipt.normalizedStateBytes,
    captureCompletedAt: receipt.captureCompletedAt,
    mintVerification: "verified-in-composing-process" as const,
    mintVerificationSurvivesSerialization: false as const
  }) as ProviderSnapshot;
}

function providerFreshness(): ProviderFreshness {
  return freezeRecord({
    status: "unassessed" as const,
    reasonId: "single-read-no-head-revalidation" as const
  });
}

function exactRef(left: GraphRef, right: GraphRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function nomination(
  assertion: GraphAssertion,
  role: "core" | "change" | "support"
): Readonly<{
  readonly assertionId: string;
  readonly nominationId: string;
  readonly role: "core" | "change" | "support";
}> {
  const suffix = ASSERTION_ID_SUFFIX.exec(assertion.id)?.[1];
  if (suffix === undefined) {
    bindingFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "core-nomination-unavailable",
      "/graphObservationReceipt/projection/assertions"
    );
  }
  return freezeRecord({
    assertionId: assertion.id,
    nominationId: `${role}-${suffix}`,
    role
  });
}

function deriveNominations(
  observation: ContinuityObservationReceipt,
  scope: LocalAttunementSnapshotScope
): DerivedProviderGraphNominations {
  const seed = continuityThreadGraphRef(scope);
  const admissible = observation.projection.assertions.filter(
    (assertion) => assertion.epistemicClass !== "model-hypothesis"
  );
  const core = admissible.filter(
    (assertion) =>
      assertion.predicate === "SCOPED_TO"
      && exactRef(assertion.object, seed)
  );
  if (core.length !== 1) {
    bindingFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "core-nomination-unavailable",
      "/graphObservationReceipt/projection/assertions"
    );
  }
  const optionals = admissible
    .filter((assertion) => assertion.id !== core[0]!.id)
    .sort((left, right) => RAW(left.id, right.id));
  const retained = optionals.slice(0, 255);
  const omittedIds = optionals.slice(255).map((assertion) => assertion.id);
  const preparedOptionals = retained.map((assertion) => {
    const role = assertion.predicate === "SUPERSEDES"
      || assertion.predicate === "PRODUCED_OUTCOME"
      ? "change" as const
      : "support" as const;
    return nomination(assertion, role);
  });
  const counts = freezeRecord({
    core: 1 as const,
    change: preparedOptionals.filter((item) => item.role === "change").length,
    support: preparedOptionals.filter((item) => item.role === "support").length,
    omitted: omittedIds.length,
    omittedAssertionIdsDigest: canonicalOmittedIdsDigest(omittedIds)
  });
  return freezeRecord({
    input: freezeArray([nomination(core[0]!, "core"), ...preparedOptionals]),
    counts
  });
}

function captureObservation(
  provider: LocalAttunementSnapshotReceiptV1,
  state: unknown
): ContinuityObservationReceipt {
  let observation: ContinuityObservationReceipt;
  try {
    observation = verifyContinuityObservation(
      captureContinuityObservation({
        scope: provider.scope,
        sourceObservedAt: provider.captureCompletedAt,
        state
      })
    );
  } catch {
    bindingFail(
      "GRAPH_OBSERVATION_FAILED",
      "graph-observation-failed",
      "/graphObservationReceipt"
    );
  }
  if (
    observation.authority !== "caller-declared-observation"
    || observation.formatVersion !== "muse.continuity-observation.v1"
    || observation.observedAt !== provider.captureCompletedAt
    || !sameJson(observation.projection.scope, provider.scope)
  ) {
    bindingFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "graph-observation-boundary-mismatch",
      "/graphObservationReceipt"
    );
  }
  return observation;
}

function assertGraphBoundary(
  graph: ReceiptBoundGraphEvidenceV1,
  observation: ContinuityObservationReceipt,
  provider: LocalAttunementSnapshotReceiptV1,
  expectedStatus: "partial" | "abstained"
): void {
  const seed = continuityThreadGraphRef(provider.scope);
  if (
    graph.receipt.status !== expectedStatus
    || graph.legacyCompilation.status !== expectedStatus
    || graph.receipt.sourceObservationReceiptId !== observation.receiptId
    || !sameJson(graph.receipt.sourceScope, provider.scope)
    || !exactRef(graph.receipt.actualSeed, seed)
  ) {
    bindingFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "graph-evidence-boundary-mismatch",
      "/graphEvidence"
    );
  }
}

const COMMON_FIELDS = [
  "schemaVersion",
  "receiptVersion",
  "receiptId",
  "authority",
  "status",
  "stage",
  "providerReceiptId",
  "providerId",
  "providerVersion",
  "providerScope",
  "providerCaptureCompletedAt",
  "providerFreshness",
  "mintVerification",
  "mintVerificationSurvivesSerialization",
  "coverage"
] as const;
const PROVIDER_FIELDS = [
  ...COMMON_FIELDS,
  "providerAbstentionReason",
  "providerCoverageReasons"
] as const;
const GRAPH_FIELDS = [
  ...COMMON_FIELDS,
  "providerStateDigest",
  "providerNormalizedStateBytes",
  "graphObservationReceiptId",
  "graphObservationReceiptVersion",
  "graphObservationAuthority",
  "graphObservedAtSemantics",
  "graphEvidenceReceiptId",
  "graphActivationEvidenceId",
  "graphActualSeed",
  "nominations",
  "budget",
  "snapshot",
  "declaredFreshness"
] as const;

function record(
  value: unknown,
  required: readonly string[],
  path: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    receiptFail("INVALID_RECEIPT", "invalid-container", path);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || keys.length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) =>
      typeof key === "string" && !required.includes(key)
    )
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-field-set", path);
  }
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  maximum: number,
  path: string
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
    || Reflect.ownKeys(value).some((key) =>
      typeof key !== "string"
      || (
        key !== "length"
        && !/^(?:0|[1-9][0-9]*)$/u.test(key)
      )
    )
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-container", path);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      receiptFail("INVALID_RECEIPT", "invalid-container", path);
    }
  }
  return value;
}

function text(
  value: unknown,
  path: string,
  maximum = 512
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maximum
    || CONTROL.test(value)
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-string", path);
  }
  return value;
}

function instant(value: unknown, path: string): string {
  const output = text(value, path, 64);
  const date = new Date(output);
  if (
    !Number.isFinite(date.getTime())
    || date.toISOString() !== output
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-instant", path);
  }
  return output;
}

function safeInteger(
  value: unknown,
  maximum: number,
  path: string
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > maximum
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-safe-integer", path);
  }
  return value as number;
}

function scope(
  value: unknown,
  path: string
): LocalAttunementSnapshotScope {
  const root = record(value, ["sourceId", "threadId"], path);
  const sourceId = text(root.sourceId, `${path}/sourceId`, 128);
  if (!SOURCE_ID.test(sourceId)) {
    receiptFail("INVALID_RECEIPT", "invalid-string", `${path}/sourceId`);
  }
  return freezeRecord({
    sourceId,
    threadId: text(root.threadId, `${path}/threadId`, 512)
  });
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
  path: string
): readonly string[] {
  const output = array(value, expected.length, path);
  if (
    output.length !== expected.length
    || output.some((item, index) => item !== expected[index])
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-literal", path);
  }
  return freezeArray(output as readonly string[]);
}

function parseCommon(
  root: Record<string, unknown>
): Omit<BindingReceiptCommon, "receiptId"> & Readonly<{
  readonly receiptId: string;
}> {
  if (
    root.schemaVersion !== 1
    || root.receiptVersion
      !== "muse.provider-bound-graph-evidence-receipt.v1"
    || root.authority !== "receipt-integrity-only"
    || root.status !== "abstained"
    || root.providerId !== "muse.local-attunement-store"
    || root.providerVersion
      !== "muse.local-attunement-snapshot-provider.v1"
    || root.mintVerification !== "verified-in-composing-process"
    || root.mintVerificationSurvivesSerialization !== false
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-literal", "");
  }
  const receiptId = text(root.receiptId, "/receiptId", 128);
  const providerReceiptId = text(
    root.providerReceiptId,
    "/providerReceiptId",
    128
  );
  if (!BINDING_RECEIPT_ID.test(receiptId)) {
    receiptFail("INVALID_RECEIPT", "invalid-id", "/receiptId");
  }
  if (!PROVIDER_RECEIPT_ID.test(providerReceiptId)) {
    receiptFail("INVALID_RECEIPT", "invalid-id", "/providerReceiptId");
  }
  const providerFreshness = record(
    root.providerFreshness,
    ["status", "reason"],
    "/providerFreshness"
  );
  if (
    providerFreshness.status !== "unassessed"
    || providerFreshness.reason !== "single-read-no-head-revalidation"
  ) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-literal",
      "/providerFreshness"
    );
  }
  return freezeRecord({
    schemaVersion: 1 as const,
    receiptVersion:
      "muse.provider-bound-graph-evidence-receipt.v1" as const,
    receiptId,
    authority: "receipt-integrity-only" as const,
    status: "abstained" as const,
    providerReceiptId,
    providerId: "muse.local-attunement-store" as const,
    providerVersion:
      "muse.local-attunement-snapshot-provider.v1" as const,
    providerScope: scope(root.providerScope, "/providerScope"),
    providerCaptureCompletedAt: instant(
      root.providerCaptureCompletedAt,
      "/providerCaptureCompletedAt"
    ),
    providerFreshness: freezeRecord({
      status: "unassessed" as const,
      reason: "single-read-no-head-revalidation" as const
    }),
    mintVerification: "verified-in-composing-process" as const,
    mintVerificationSurvivesSerialization: false as const
  });
}

function parseCoverage(
  value: unknown,
  expectedReasons: readonly ProviderGraphCoverageReason[],
  path: string
): BindingCoverage<readonly ProviderGraphCoverageReason[]> {
  const root = record(value, [
    "status",
    "canAssertAbsenceWithinSnapshot",
    "canAssertCurrentWorldAbsence",
    "canAssertFreshness",
    "canAssertDurableProviderAuthority",
    "reasons"
  ], path);
  if (
    root.status !== "abstained"
    || root.canAssertAbsenceWithinSnapshot !== false
    || root.canAssertCurrentWorldAbsence !== false
    || root.canAssertFreshness !== false
    || root.canAssertDurableProviderAuthority !== false
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-literal", path);
  }
  return freezeRecord({
    status: "abstained" as const,
    canAssertAbsenceWithinSnapshot: false as const,
    canAssertCurrentWorldAbsence: false as const,
    canAssertFreshness: false as const,
    canAssertDurableProviderAuthority: false as const,
    reasons: exactStringArray(
      root.reasons,
      expectedReasons,
      `${path}/reasons`
    ) as readonly ProviderGraphCoverageReason[]
  });
}

function parseProviderReceipt(
  root: Record<string, unknown>
): ProviderGraphBindingReceiptV1 {
  const common = parseCommon(root);
  const reasons = ["provider-unavailable"] as const;
  const abstentionReasons = [
    "source-read-failed",
    "requested-scope-unavailable",
    "source-capacity-exceeded"
  ] as const;
  if (
    root.stage !== "provider"
    || !abstentionReasons.includes(
      root.providerAbstentionReason as (typeof abstentionReasons)[number]
    )
  ) {
    receiptFail("INVALID_RECEIPT", "stage-field-mismatch", "/stage");
  }
  const providerCoverageReasons = exactStringArray(
    root.providerCoverageReasons,
    ["no-available-provider-snapshot"],
    "/providerCoverageReasons"
  ) as readonly ["no-available-provider-snapshot"];
  return freezeRecord({
    ...common,
    stage: "provider" as const,
    coverage: (
      parseCoverage(root.coverage, reasons, "/coverage")
    ) as BindingCoverage<ProviderStageCoverageReasons>,
    providerAbstentionReason:
      root.providerAbstentionReason as LocalAttunementSnapshotAbstentionReason,
    providerCoverageReasons
  });
}

function parseGraphRef(value: unknown, path: string): GraphRef {
  const root = record(value, ["id", "kind"], path);
  if (
    root.kind !== "thread"
    || typeof root.id !== "string"
    || !THREAD_SEED_ID.test(root.id)
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-id", path);
  }
  return freezeRecord({ id: root.id, kind: "thread" as const });
}

function parseBudget(value: unknown): typeof PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET {
  const root = record(value, [
    "maxAssertions",
    "maxConsideredAssertions",
    "maxDepth",
    "maxEstimatedTokens",
    "maxOutputBytes",
    "maxVisitedRefs"
  ], "/budget");
  if (!sameJson(root, PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET)) {
    receiptFail("INVALID_RECEIPT", "invalid-literal", "/budget");
  }
  return PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET;
}

function parseProviderSnapshot(value: unknown): ProviderSnapshot {
  const root = record(value, [
    "authority",
    "kind",
    "providerReceiptId",
    "providerId",
    "providerVersion",
    "stateDigest",
    "normalizedStateBytes",
    "captureCompletedAt",
    "mintVerification",
    "mintVerificationSurvivesSerialization"
  ], "/snapshot");
  if (
    root.authority !== "receipt-integrity-only"
    || root.kind !== "process-local-provider-capture"
    || root.providerId !== "muse.local-attunement-store"
    || root.providerVersion
      !== "muse.local-attunement-snapshot-provider.v1"
    || root.mintVerification !== "verified-in-composing-process"
    || root.mintVerificationSurvivesSerialization !== false
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-literal", "/snapshot");
  }
  const providerReceiptId = text(
    root.providerReceiptId,
    "/snapshot/providerReceiptId",
    128
  );
  const digest = text(root.stateDigest, "/snapshot/stateDigest", 71);
  if (!PROVIDER_RECEIPT_ID.test(providerReceiptId)) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-id",
      "/snapshot/providerReceiptId"
    );
  }
  if (!DIGEST.test(digest)) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-digest",
      "/snapshot/stateDigest"
    );
  }
  return freezeRecord({
    authority: "receipt-integrity-only" as const,
    kind: "process-local-provider-capture" as const,
    providerReceiptId,
    providerId: "muse.local-attunement-store" as const,
    providerVersion:
      "muse.local-attunement-snapshot-provider.v1" as const,
    stateDigest: digest,
    normalizedStateBytes: safeInteger(
      root.normalizedStateBytes,
      LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES,
      "/snapshot/normalizedStateBytes"
    ),
    captureCompletedAt: instant(
      root.captureCompletedAt,
      "/snapshot/captureCompletedAt"
    ),
    mintVerification: "verified-in-composing-process" as const,
    mintVerificationSurvivesSerialization: false as const
  });
}

function parseGraphReceipt(
  root: Record<string, unknown>
): ProviderGraphBindingReceiptV1 {
  const common = parseCommon(root);
  if (
    root.stage !== "graph-evidence"
    || root.graphObservationReceiptVersion
      !== "muse.continuity-observation.v1"
    || root.graphObservationAuthority !== "caller-declared-observation"
    || root.graphObservedAtSemantics
      !== "provider-capture-completed-by-bound"
  ) {
    receiptFail("INVALID_RECEIPT", "stage-field-mismatch", "/stage");
  }
  const providerStateDigest = text(
    root.providerStateDigest,
    "/providerStateDigest",
    71
  );
  if (!DIGEST.test(providerStateDigest)) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-digest",
      "/providerStateDigest"
    );
  }
  const observationId = text(
    root.graphObservationReceiptId,
    "/graphObservationReceiptId",
    128
  );
  const evidenceId = text(
    root.graphEvidenceReceiptId,
    "/graphEvidenceReceiptId",
    128
  );
  const activationId = text(
    root.graphActivationEvidenceId,
    "/graphActivationEvidenceId",
    128
  );
  if (!OBSERVATION_RECEIPT_ID.test(observationId)) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-id",
      "/graphObservationReceiptId"
    );
  }
  if (!GRAPH_EVIDENCE_RECEIPT_ID.test(evidenceId)) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-id",
      "/graphEvidenceReceiptId"
    );
  }
  if (!GRAPH_ACTIVATION_EVIDENCE_ID.test(activationId)) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-id",
      "/graphActivationEvidenceId"
    );
  }
  const nominations = record(root.nominations, [
    "core",
    "change",
    "support",
    "omitted",
    "omittedAssertionIdsDigest"
  ], "/nominations");
  if (nominations.core !== 1) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-count-accounting",
      "/nominations/core"
    );
  }
  const change = safeInteger(nominations.change, 255, "/nominations/change");
  const support = safeInteger(
    nominations.support,
    255,
    "/nominations/support"
  );
  const omitted = safeInteger(
    nominations.omitted,
    256,
    "/nominations/omitted"
  );
  if (change + support > 255) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-count-accounting",
      "/nominations"
    );
  }
  const omittedDigest = nominations.omittedAssertionIdsDigest;
  if (
    (omitted === 0 && omittedDigest !== null)
    || (
      omitted > 0
      && (
        typeof omittedDigest !== "string"
        || !OMITTED_DIGEST.test(omittedDigest)
      )
    )
  ) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-count-accounting",
      "/nominations/omittedAssertionIdsDigest"
    );
  }
  const expectedReasons = omitted === 0
    ? [
        "single-local-store",
        "point-in-time-read",
        "freshness-unassessed",
        "source-authority-unverified",
        "graph-settlement-abstained"
      ] as const
    : [
        "single-local-store",
        "point-in-time-read",
        "freshness-unassessed",
        "source-authority-unverified",
        "nomination-capacity-bounded",
        "graph-settlement-abstained"
      ] as const;
  const snapshot = parseProviderSnapshot(root.snapshot);
  const freshness = record(
    root.declaredFreshness,
    ["status", "reasonId"],
    "/declaredFreshness"
  );
  if (
    freshness.status !== "unassessed"
    || freshness.reasonId !== "single-read-no-head-revalidation"
  ) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-literal",
      "/declaredFreshness"
    );
  }
  const declaredFreshness = freezeRecord({
    status: "unassessed" as const,
    reasonId: "single-read-no-head-revalidation" as const
  });
  if (
    snapshot.providerReceiptId !== common.providerReceiptId
    || snapshot.stateDigest !== providerStateDigest
    || snapshot.normalizedStateBytes !== root.providerNormalizedStateBytes
    || snapshot.captureCompletedAt !== common.providerCaptureCompletedAt
  ) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-count-accounting",
      "/snapshot"
    );
  }
  const graphActualSeed = parseGraphRef(
    root.graphActualSeed,
    "/graphActualSeed"
  );
  if (
    !exactRef(
      graphActualSeed,
      continuityThreadGraphRef(common.providerScope)
    )
  ) {
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-count-accounting",
      "/graphActualSeed"
    );
  }
  return freezeRecord({
    ...common,
    stage: "graph-evidence" as const,
    coverage: (
      parseCoverage(root.coverage, expectedReasons, "/coverage")
    ) as BindingCoverage<GraphStageCoverageReasons>,
    providerStateDigest,
    providerNormalizedStateBytes: safeInteger(
      root.providerNormalizedStateBytes,
      LOCAL_ATTUNEMENT_SNAPSHOT_MAX_NORMALIZED_STATE_BYTES,
      "/providerNormalizedStateBytes"
    ),
    graphObservationReceiptId: observationId,
    graphObservationReceiptVersion:
      "muse.continuity-observation.v1" as const,
    graphObservationAuthority: "caller-declared-observation" as const,
    graphObservedAtSemantics:
      "provider-capture-completed-by-bound" as const,
    graphEvidenceReceiptId: evidenceId,
    graphActivationEvidenceId: activationId,
    graphActualSeed,
    nominations: freezeRecord({
      core: 1 as const,
      change,
      support,
      omitted,
      omittedAssertionIdsDigest:
        omittedDigest as string | null
    }),
    budget: parseBudget(root.budget),
    snapshot,
    declaredFreshness
  });
}

function receiptDescriptor(input: unknown): PropertyDescriptor {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    receiptFail("INVALID_RECEIPT", "invalid-container", "");
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, "receiptId");
  } catch {
    receiptFail("INVALID_RECEIPT", "invalid-container", "");
  }
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
  ) {
    receiptFail("INVALID_RECEIPT", "invalid-field-set", "/receiptId");
  }
  return descriptor;
}

export function verifyProviderGraphBindingReceipt(
  input: unknown
): ProviderGraphBindingReceiptV1 {
  receiptDescriptor(input);
  let envelope: Record<string, unknown>;
  try {
    envelope = canonicalizeImmutableEnvelope(
      input,
      "external-mutable",
      BINDING_RECEIPT_SPEC
    ).envelope as Record<string, unknown>;
  } catch (cause) {
    if (
      cause instanceof CanonicalImmutableEnvelopeError
      && cause.code === "INTEGRITY_MISMATCH"
    ) {
      receiptFail(
        "INTEGRITY_MISMATCH",
        "receipt-id-mismatch",
        "/receiptId"
      );
    }
    receiptFail(
      "INVALID_RECEIPT",
      "invalid-container",
      cause instanceof CanonicalImmutableEnvelopeError
        ? cause.details.path
        : ""
    );
  }
  const stage = envelope.stage;
  const root = record(
    envelope,
    stage === "provider"
      ? PROVIDER_FIELDS
      : stage === "graph-evidence"
        ? GRAPH_FIELDS
        : COMMON_FIELDS,
    ""
  );
  return stage === "provider"
    ? parseProviderReceipt(root)
    : stage === "graph-evidence"
      ? parseGraphReceipt(root)
      : receiptFail("INVALID_RECEIPT", "stage-field-mismatch", "/stage");
}

function sealReceipt(
  body: Record<string, unknown>
): ProviderGraphBindingReceiptV1 {
  try {
    const first = canonicalizeImmutableEnvelope(
      JSON.parse(JSON.stringify(body)),
      "external-mutable",
      BINDING_RECEIPT_SPEC
    );
    const second = canonicalizeImmutableEnvelope(
      first.envelope,
      "muse-frozen",
      BINDING_RECEIPT_SPEC
    );
    if (
      first.contentId !== second.contentId
      || first.canonicalJson !== second.canonicalJson
      || first.canonicalByteLength !== second.canonicalByteLength
    ) {
      bindingFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "binding-receipt-postcondition-failed",
        "/receipt"
      );
    }
    const verified = verifyProviderGraphBindingReceipt(
      JSON.parse(JSON.stringify(second.envelope))
    );
    if (verified.receiptId !== second.contentId) {
      bindingFail(
        "INTERNAL_POSTCONDITION_FAILED",
        "binding-receipt-postcondition-failed",
        "/receipt"
      );
    }
    return verified;
  } catch (cause) {
    if (cause instanceof ProviderBoundGraphEvidenceError) throw cause;
    bindingFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "binding-receipt-postcondition-failed",
      "/receipt"
    );
  }
}

function commonReceiptBody(
  receipt:
    | LocalAttunementSnapshotReceiptV1
    | LocalAttunementSnapshotAbstentionReceiptV1
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    receiptVersion:
      "muse.provider-bound-graph-evidence-receipt.v1",
    authority: "receipt-integrity-only",
    status: "abstained",
    providerReceiptId: receipt.receiptId,
    providerId: receipt.providerId,
    providerVersion: receipt.providerVersion,
    providerScope: receipt.scope,
    providerCaptureCompletedAt: receipt.captureCompletedAt,
    providerFreshness: {
      status: "unassessed",
      reason: "single-read-no-head-revalidation"
    },
    mintVerification: "verified-in-composing-process",
    mintVerificationSurvivesSerialization: false
  };
}

function providerStageReceipt(
  receipt: LocalAttunementSnapshotAbstentionReceiptV1
): ProviderGraphBindingReceiptV1 {
  return sealReceipt({
    ...commonReceiptBody(receipt),
    stage: "provider",
    coverage: {
      status: "abstained",
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      canAssertFreshness: false,
      canAssertDurableProviderAuthority: false,
      reasons: ["provider-unavailable"]
    },
    providerAbstentionReason: receipt.reason,
    providerCoverageReasons: receipt.coverage.reasons
  });
}

function graphStageReceipt(input: Readonly<{
  readonly provider: LocalAttunementSnapshotReceiptV1;
  readonly observation: ContinuityObservationReceipt;
  readonly graph: ReceiptBoundGraphEvidenceV1;
  readonly nominations: DerivedProviderGraphNominations;
  readonly snapshot: ProviderSnapshot;
  readonly freshness: ProviderFreshness;
}>): ProviderGraphBindingReceiptV1 {
  const reasons: ProviderGraphCoverageReason[] = [
    "single-local-store",
    "point-in-time-read",
    "freshness-unassessed",
    "source-authority-unverified"
  ];
  if (input.nominations.counts.omitted > 0) {
    reasons.push("nomination-capacity-bounded");
  }
  reasons.push("graph-settlement-abstained");
  return sealReceipt({
    ...commonReceiptBody(input.provider),
    stage: "graph-evidence",
    coverage: {
      status: "abstained",
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      canAssertFreshness: false,
      canAssertDurableProviderAuthority: false,
      reasons
    },
    providerStateDigest: input.provider.stateDigest,
    providerNormalizedStateBytes: input.provider.normalizedStateBytes,
    graphObservationReceiptId: input.observation.receiptId,
    graphObservationReceiptVersion: input.observation.formatVersion,
    graphObservationAuthority: input.observation.authority,
    graphObservedAtSemantics: "provider-capture-completed-by-bound",
    graphEvidenceReceiptId: input.graph.receipt.receiptId,
    graphActivationEvidenceId: input.graph.activationEvidence.evidenceId,
    graphActualSeed: input.graph.receipt.actualSeed,
    nominations: input.nominations.counts,
    budget: PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET,
    snapshot: input.snapshot,
    declaredFreshness: input.freshness
  });
}

export type ProviderCaptureGraphProjection = Readonly<{
  readonly provider: LocalAttunementSnapshotReceiptV1;
  readonly observation: ContinuityObservationReceipt;
  readonly nominations: DerivedProviderGraphNominations;
  readonly graph: ReceiptBoundGraphEvidenceV1;
}>;

/**
 * Private cross-composer projection seam. The old single-read composer and
 * the head-revalidated composer share this exact local-state → Graph path so
 * their only semantic difference is the closed snapshot/freshness pair.
 */
export async function projectAvailableProviderCaptureToGraphEvidence(
  input: Readonly<{
    readonly capture: unknown;
    readonly snapshot: GraphSnapshotProvenanceV1;
    readonly freshness: GraphDeclaredFreshnessV1;
    readonly expectedStatus: "partial" | "abstained";
  }>
): Promise<ProviderCaptureGraphProjection> {
  const verified = verifyCapture(input.capture);
  if (verified.status !== "available") {
    bindingFail("INVALID_CAPTURE", "capture-not-minted", "/capture");
  }
  const source = readAvailableState(verified);
  const provider = verified.receipt;
  const observation = captureObservation(provider, source.state);
  const nominations = deriveNominations(observation, provider.scope);
  try {
    assertGraphSnapshotFreshnessPair(
      input.snapshot,
      input.freshness,
      "/snapshot",
      "/declaredFreshness"
    );
  } catch {
    bindingFail(
      "INTERNAL_POSTCONDITION_FAILED",
      "graph-evidence-boundary-mismatch",
      "/graphEvidence"
    );
  }
  let graph: ReceiptBoundGraphEvidenceV1;
  try {
    graph = await compileReceiptBoundGraphEvidence(
      JSON.parse(JSON.stringify({
        schemaVersion: 1,
        operatorVersion: "muse.receipt-bound-graph-evidence.v1",
        scope: provider.scope,
        currentGraphObservationReceipt: observation,
        recordedAtOrBefore: provider.captureCompletedAt,
        snapshot: input.snapshot,
        declaredFreshness: input.freshness,
        nominations: {
          core: nominations.input[0],
          optionals: nominations.input.slice(1)
        },
        legacyBudget: PROVIDER_BOUND_GRAPH_EVIDENCE_BUDGET
      }))
    );
  } catch {
    bindingFail(
      "GRAPH_EVIDENCE_FAILED",
      "graph-evidence-failed",
      "/graphEvidence"
    );
  }
  assertGraphBoundary(
    graph,
    observation,
    provider,
    input.expectedStatus
  );
  return freezeRecord({ provider, observation, nominations, graph });
}

export async function compileProviderBoundGraphEvidence(
  capture: unknown
): Promise<ProviderBoundGraphEvidenceV1> {
  const verified = verifyCapture(capture);
  if (verified.status === "abstained") {
    const receipt = providerStageReceipt(verified.receipt);
    return freezeRecord({
      status: "abstained" as const,
      stage: "provider" as const,
      providerReceipt: verified.receipt,
      receipt
    });
  }
  const provider = verified.receipt;
  const snapshot = providerSnapshot(provider);
  const freshness = providerFreshness();
  const projection = await projectAvailableProviderCaptureToGraphEvidence({
    capture: verified,
    snapshot,
    freshness,
    expectedStatus: "abstained"
  });
  const receipt = graphStageReceipt({
    provider,
    observation: projection.observation,
    graph: projection.graph,
    nominations: projection.nominations,
    snapshot,
    freshness
  });
  const result = freezeRecord({
    status: "abstained" as const,
    stage: "graph-evidence" as const,
    providerReceipt: provider,
    graphObservationReceipt: projection.observation,
    graphEvidence: projection.graph,
    receipt
  });
  return freezeTree(result);
}
