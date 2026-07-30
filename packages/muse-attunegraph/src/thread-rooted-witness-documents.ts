import { createHash } from "node:crypto";

import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "@attunegraph/core/extension-kit";
import type {
  ScopedProofDocumentSettlementResultV1
} from "./scoped-proof-document-settlement.js";
import {
  type FairWitnessFrontierCompositionV1,
  type FairWitnessFrontierDisposition,
  settleFairWitnessFrontier
} from "./fair-witness-frontier-settlement.js";
import { continuityThreadGraphRef } from "./continuity-projection.js";
import { AttuneGraphDataError } from "@attunegraph/core";
import {
  findThreadRootedWitnessPath,
  type ThreadRootedWitnessPathStep
} from "@attunegraph/core/extension-kit";
import type {
  GraphAssertion,
  GraphEvidenceRef,
  GraphNodeKind,
  GraphQueryPlan,
  GraphRef
} from "@attunegraph/core";
import { GRAPH_NODE_KINDS } from "@attunegraph/core";
import {
  evidenceRefKey,
  graphRefKey,
  instantEpoch,
  normalizeGraphAssertion,
  normalizeGraphQueryPlan
} from "@attunegraph/core/extension-kit";
import {
  GraphSnapshotProvenanceError,
  assertGraphSnapshotFreshnessScopePair,
  parseGraphDeclaredFreshness,
  parseGraphSnapshotProvenance,
  type GraphDeclaredFreshnessV1,
  type GraphSnapshotProvenanceV1
} from "./graph-snapshot-provenance.js";

const REQUEST_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.thread-rooted-witness-request.v1",
  idField: "requestId",
  idPrefix: "muse-attunegraph-thread-rooted-witness-request:sha256:"
} as const);
const ADMISSION_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.thread-rooted-witness-admission.v1",
  idField: "admissionId",
  idPrefix: "muse-attunegraph-thread-rooted-witness-admission:sha256:"
} as const);
const RECEIPT_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.thread-rooted-witness-receipt.v1",
  idField: "receiptId",
  idPrefix: "muse-attunegraph-thread-rooted-witness-receipt:sha256:"
} as const);
const DOCUMENT_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.scoped-proof-document.v1",
  idField: "documentId",
  idPrefix: "muse-attunegraph-scoped-proof-document:sha256:"
} as const);
const RETAINED_ENTRY_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.thread-rooted-retained-witness-entry.v1",
  idField: "entryId",
  idPrefix: "muse-attunegraph-thread-rooted-retained-witness-entry:sha256:"
} as const);
const RETAINED_MANIFEST_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.thread-rooted-retained-witness-manifest.v1",
  idField: "manifestId",
  idPrefix: "muse-attunegraph-thread-rooted-retained-witness-manifest:sha256:"
} as const);
const FOCUS_ASSERTION_DIGEST_DOMAIN =
  "muse.attunegraph.thread-rooted-retained-witness-focus-assertion.v1";
const THREAD_DISPOSITIONS_DIGEST_DOMAIN =
  "muse.attunegraph.thread-rooted-retained-witness-thread-dispositions.v1";
const FRONTIER_DISPOSITIONS_DIGEST_DOMAIN =
  "muse.attunegraph.thread-rooted-retained-witness-frontier-dispositions.v1";
const FAIR_ORDER_DIGEST_DOMAIN =
  "muse.attunegraph.thread-rooted-retained-witness-fair-order.v1";

const RAW = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const REQUEST_ID = /^muse-attunegraph-thread-rooted-witness-request:sha256:[0-9a-f]{64}$/u;
const RECEIPT_ID = /^muse-attunegraph-thread-rooted-witness-receipt:sha256:[0-9a-f]{64}$/u;
const RETAINED_ENTRY_ID =
  /^muse-attunegraph-thread-rooted-retained-witness-entry:sha256:[0-9a-f]{64}$/u;
const RETAINED_MANIFEST_ID =
  /^muse-attunegraph-thread-rooted-retained-witness-manifest:sha256:[0-9a-f]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ASSERTIONS = 256;
const MAX_MEMBERSHIPS = 32;
const MAX_OPTIONALS = 255;

type Scope = Readonly<{ readonly sourceId: string; readonly threadId: string }>;
type Snapshot = GraphSnapshotProvenanceV1;
type Freshness = GraphDeclaredFreshnessV1;
type Budget = Readonly<{
  readonly maxAssertions: number;
  readonly maxConsideredAssertions: number;
  readonly maxDepth: number;
  readonly maxEstimatedTokens: number;
  readonly maxOutputBytes: number;
  readonly maxVisitedRefs: number;
}>;
type ScopedAssertion = Readonly<{
  readonly assertion: GraphAssertion;
  readonly memberships: readonly Scope[];
}>;
type Nomination = Readonly<{
  readonly assertionId: string;
  readonly kind: "core" | "change" | "support";
  readonly nominationId: string;
  readonly observedAt: string;
}>;

export type ThreadRootedWitnessDisposition =
  | Readonly<{
      readonly assertionId: string;
      readonly documentId: string;
      readonly nominationId: string;
      readonly role: "core" | "optional";
      readonly status: "witnessed";
    }>
  | Readonly<{
      readonly assertionId: string;
      readonly nominationId: string;
      readonly reason:
        | "not-in-bounded-result"
        | "not-plan-eligible"
        | "not-scope-eligible"
        | "not-thread-rooted";
      readonly role: "core" | "optional";
      readonly status: "excluded";
    }>;

export type ThreadRootedWitnessReceiptV1 = Readonly<{
  readonly coverage: Readonly<{
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly reasons: readonly (
      | "caller-declared-snapshot"
      | "provider-capture-snapshot-integrity-only"
      | "provider-head-revalidation-snapshot-integrity-only"
      | "fresh-at-assessment-only"
      | "freshness-unassessed"
      | "bounded-result-only"
      | "traversal-truncated"
      | "nomination-excluded"
      | "core-witness-unavailable"
    )[];
    readonly status: "partial";
  }>;
  readonly declaredFreshness: Freshness;
  readonly dispositions: readonly ThreadRootedWitnessDisposition[];
  readonly receiptId: string;
  readonly receiptVersion: "muse.thread-rooted-witness-receipt.v1";
  readonly requestId: string;
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly frontierReceiptId?: string;
  readonly settlementResultId?: string;
  readonly snapshot: Snapshot;
  readonly status: "partial" | "abstained";
}>;

export type ThreadRootedWitnessCompilationV1 = Readonly<{
  readonly frontier?: Readonly<{
    readonly order: FairWitnessFrontierCompositionV1["order"];
    readonly receipt: FairWitnessFrontierCompositionV1["receipt"];
  }>;
  readonly receipt: ThreadRootedWitnessReceiptV1;
  readonly settlement?: ScopedProofDocumentSettlementResultV1;
  readonly status: "partial" | "abstained";
}>;

type RetainedWitnessEntryCommonV1 = Readonly<{
  readonly assertionId: string;
  readonly candidateId: string;
  readonly documentId: string;
  readonly entryId: string;
  readonly entryVersion:
    "muse.thread-rooted-retained-witness-entry.v1";
  readonly focusAssertionDigest: string;
  readonly focusAssertionId: string;
  readonly nominationId: string;
  readonly observedAt: string;
  readonly schemaVersion: 1;
}>;

export type ThreadRootedRetainedWitnessCoreEntryV1 =
  RetainedWitnessEntryCommonV1 & Readonly<{
    readonly frontierCore: Readonly<{
      readonly candidateId: string;
      readonly documentId: string;
    }>;
    readonly role: "core";
  }>;

export type ThreadRootedRetainedWitnessOptionalEntryV1 =
  RetainedWitnessEntryCommonV1 & Readonly<{
    readonly frontierDisposition: FairWitnessFrontierDisposition;
    readonly role: "optional";
  }>;

export type ThreadRootedRetainedWitnessEntryV1 =
  | ThreadRootedRetainedWitnessCoreEntryV1
  | ThreadRootedRetainedWitnessOptionalEntryV1;

export type ThreadRootedRetainedWitnessManifestV1 = Readonly<{
  readonly coreEntryId: string;
  readonly counts: Readonly<{
    readonly excludedThreadNominations: number;
    readonly fairOrderedOptionals: number;
    readonly frontierDispositions: number;
    readonly laneUndeterminedOptionals: number;
    readonly threadDispositions: number;
    readonly witnessedOptionals: number;
  }>;
  readonly declaredFreshness: Freshness;
  readonly fairOrderDigest: string;
  readonly fairOrderedOptionalEntryIds: readonly string[];
  readonly frontierDispositionsDigest: string;
  readonly frontierOrderId: string;
  readonly frontierReceiptId: string;
  readonly frontierSettlementResultId: string;
  readonly laneUndeterminedEntryIds: readonly string[];
  readonly manifestId: string;
  readonly manifestVersion:
    "muse.thread-rooted-retained-witness-manifest.v1";
  readonly requestId: string;
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly seed: Readonly<{ readonly id: string; readonly kind: "thread" }>;
  readonly snapshot: Snapshot;
  readonly threadDispositionsDigest: string;
}>;

export type ThreadRootedRetainedWitnessInventoryV1 = Readonly<{
  readonly manifest: ThreadRootedRetainedWitnessManifestV1;
  readonly registry: Readonly<{
    readonly core: Readonly<{
      readonly document: Readonly<Record<string, unknown>>;
      readonly entry: ThreadRootedRetainedWitnessCoreEntryV1;
      readonly focusAssertion: GraphAssertion;
    }>;
    readonly optionals: readonly Readonly<{
      readonly document: Readonly<Record<string, unknown>>;
      readonly entry: ThreadRootedRetainedWitnessOptionalEntryV1;
      readonly focusAssertion: GraphAssertion;
    }>[];
  }>;
}>;

const retainedWitnessInventories =
  new WeakMap<object, ThreadRootedRetainedWitnessInventoryV1>();

/**
 * Package-private process-local lookup. Intentionally absent from index and
 * package exports; serialized, cloned, spread, or proxied compilations miss.
 */
export function getThreadRootedRetainedWitnessInventory(
  compilation: unknown
): ThreadRootedRetainedWitnessInventoryV1 | undefined {
  if (compilation === null || typeof compilation !== "object") return undefined;
  return retainedWitnessInventories.get(compilation);
}

export type ThreadRootedWitnessDocumentsErrorCode =
  | "INVALID_REQUEST"
  | "INTERNAL_POSTCONDITION_FAILED";

export class ThreadRootedWitnessDocumentsError extends Error {
  readonly code: ThreadRootedWitnessDocumentsErrorCode;
  readonly details: Readonly<{ readonly path: string; readonly reason: string }>;

  constructor(
    code: ThreadRootedWitnessDocumentsErrorCode,
    reason: string,
    path: string
  ) {
    super("thread-rooted-witness-documents-failed");
    this.name = "ThreadRootedWitnessDocumentsError";
    this.code = code;
    this.details = freezeRecord({ path, reason });
    delete (this as { stack?: unknown }).stack;
    for (const key of ["message", "name", "code", "details"] as const) {
      Object.defineProperty(this, key, {
        configurable: false,
        enumerable: key === "code" || key === "details",
        value: this[key],
        writable: false
      });
    }
  }
}

function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
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
      if (descriptor && "value" in descriptor && key !== "length") {
        freezeTree(descriptor.value);
      }
    }
    Object.freeze(value);
  }
  return value;
}

function mutableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  }
  const root = value as Record<string, unknown>;
  return `{${Object.keys(root).sort(RAW).map((key) =>
    `${JSON.stringify(key)}:${canonicalValue(root[key])}`
  ).join(",")}}`;
}

function domainDigest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalValue(value), "utf8")
    .digest("hex")}`;
}

function fail(reason: string, path: string): never {
  throw new ThreadRootedWitnessDocumentsError("INVALID_REQUEST", reason, path);
}

function internal(reason: string, path = ""): never {
  throw new ThreadRootedWitnessDocumentsError(
    "INTERNAL_POSTCONDITION_FAILED",
    reason,
    path
  );
}

function child(path: string, segment: string): string {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-container", path);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) =>
      typeof key === "string"
      && !required.includes(key)
      && !optional.includes(key)
    )
  ) {
    fail("invalid-field-set", path);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, maximum: number, path: string): readonly unknown[] {
  if (
    !Array.isArray(value)
    || value.length > maximum
    || Reflect.ownKeys(value).some((key) =>
      typeof key !== "string"
      || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))
    )
  ) {
    fail("invalid-container", path);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail("invalid-container", path);
  }
  return value;
}

function text(value: unknown, path: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maximum
    || CONTROL.test(value)
  ) {
    fail("invalid-string", path);
  }
  return value;
}

function safeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("invalid-number", path);
  }
  return value as number;
}

function instant(value: unknown, path: string): string {
  const output = text(value, path, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(output)
    || Number.isNaN(Date.parse(output))
  ) {
    fail("invalid-instant", path);
  }
  return output;
}

function scope(value: unknown, path: string): Scope {
  const root = record(value, ["sourceId", "threadId"], [], path);
  const sourceId = text(root.sourceId, child(path, "sourceId"), 128);
  if (!SOURCE_ID.test(sourceId)) fail("invalid-string", child(path, "sourceId"));
  return freezeRecord({
    sourceId,
    threadId: text(root.threadId, child(path, "threadId"), 256)
  });
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

function snapshot(value: unknown, path: string): Snapshot {
  try { return parseGraphSnapshotProvenance(value, path); }
  catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) {
      const reason = cause.details.reason === "invalid-field-set"
        || cause.details.reason === "invalid-container"
        ? cause.details.reason
        : cause.details.reason === "invalid-literal"
          ? "invalid-enum"
          : cause.details.reason === "invalid-safe-integer"
            ? "invalid-number"
            : "invalid-string";
      fail(reason, cause.details.path);
    }
    throw cause;
  }
}

function freshness(value: unknown, path: string): Freshness {
  try { return parseGraphDeclaredFreshness(value, path); }
  catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) {
      const reason = cause.details.reason === "invalid-field-set"
        || cause.details.reason === "invalid-container"
        || cause.details.reason === "invalid-instant"
        || cause.details.reason === "invalid-order"
        ? cause.details.reason
        : "invalid-enum";
      fail(reason, cause.details.path);
    }
    throw cause;
  }
}

function snapshotFreshnessPair(
  snapshotValue: Snapshot,
  freshnessValue: Freshness,
  expectedScope: Scope
): void {
  try {
    assertGraphSnapshotFreshnessScopePair(
      snapshotValue,
      freshnessValue,
      expectedScope,
      {
        snapshot: "/snapshot",
        freshness: "/declaredFreshness",
        expectedScope: "/scope"
      }
    );
  }
  catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) fail("snapshot-freshness-mismatch", cause.details.path);
    throw cause;
  }
}

function budget(value: unknown, path: string): Budget {
  const fields = [
    "maxAssertions",
    "maxConsideredAssertions",
    "maxDepth",
    "maxEstimatedTokens",
    "maxOutputBytes",
    "maxVisitedRefs"
  ] as const;
  const root = record(value, fields, [], path);
  return freezeRecord(Object.fromEntries(fields.map((field) => [
    field,
    safeInteger(root[field], child(path, field))
  ])) as unknown as Budget);
}

function normalizeRef(value: unknown, path: string): GraphRef {
  const root = record(value, ["id", "kind"], [], path);
  if (!GRAPH_NODE_KINDS.includes(root.kind as GraphNodeKind)) {
    fail("invalid-graph-ref", child(path, "kind"));
  }
  return freezeRecord({
    id: text(root.id, child(path, "id"), 512),
    kind: root.kind as GraphNodeKind
  });
}

function normalizedPlan(value: unknown): GraphQueryPlan {
  try {
    return normalizeGraphQueryPlan(value as GraphQueryPlan);
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) fail("invalid-query", "/query");
    throw cause;
  }
}

function memberships(value: unknown, path: string): readonly Scope[] {
  const output = array(value, MAX_MEMBERSHIPS, path)
    .map((item, index) => scope(item, `${path}/${index.toString()}`))
    .sort((left, right) =>
      RAW(left.sourceId, right.sourceId)
      || RAW(left.threadId, right.threadId)
    );
  const keys = output.map((item) => JSON.stringify([item.sourceId, item.threadId]));
  if (new Set(keys).size !== keys.length) fail("duplicate-membership", path);
  return freezeArray(output);
}

function scopedAssertion(value: unknown, path: string): ScopedAssertion {
  const root = record(value, ["assertion", "memberships"], [], path);
  let normalized: GraphAssertion;
  try {
    normalized = normalizeGraphAssertion(root.assertion);
  } catch (cause) {
    if (cause instanceof AttuneGraphDataError) {
      fail("invalid-assertion", child(path, "assertion"));
    }
    throw cause;
  }
  if (canonicalValue(normalized) !== canonicalValue(root.assertion)) {
    fail("invalid-assertion", child(path, "assertion"));
  }
  return freezeRecord({
    assertion: normalized,
    memberships: memberships(root.memberships, child(path, "memberships"))
  });
}

function nomination(
  value: unknown,
  role: "core" | "optional",
  path: string
): Nomination {
  const root = record(
    value,
    ["assertionId", "kind", "nominationId", "observedAt"],
    [],
    path
  );
  if (
    (role === "core" && root.kind !== "core")
    || (role === "optional" && root.kind !== "change" && root.kind !== "support")
  ) {
    fail("invalid-nomination-kind", child(path, "kind"));
  }
  return freezeRecord({
    assertionId: text(root.assertionId, child(path, "assertionId")),
    kind: root.kind as Nomination["kind"],
    nominationId: text(root.nominationId, child(path, "nominationId")),
    observedAt: instant(root.observedAt, child(path, "observedAt"))
  });
}

function assertionMatchesPlan(assertion: GraphAssertion, plan: GraphQueryPlan): boolean {
  if (!plan.predicates.includes(assertion.predicate)) return false;
  if (
    plan.epistemicClasses
    && !plan.epistemicClasses.includes(assertion.epistemicClass)
  ) {
    return false;
  }
  const recordedCutoff = plan.recordedAtOrBefore
    ? instantEpoch(plan.recordedAtOrBefore)
    : undefined;
  if (
    recordedCutoff !== undefined
    && instantEpoch(assertion.recordedAt) > recordedCutoff
  ) {
    return false;
  }
  if (
    !plan.includeSuperseded
    && assertion.supersededAt
    && (
      recordedCutoff === undefined
      || instantEpoch(assertion.supersededAt) <= recordedCutoff
    )
  ) {
    return false;
  }
  if (!plan.validAt) return true;
  const validAt = instantEpoch(plan.validAt);
  return (!assertion.validFrom || instantEpoch(assertion.validFrom) <= validAt)
    && (!assertion.validTo || validAt < instantEpoch(assertion.validTo));
}

function unionSources(
  path: readonly ThreadRootedWitnessPathStep[]
): readonly GraphEvidenceRef[] {
  return freezeArray(
    [...new Map(path.flatMap((step) =>
      step.assertion.sourceRefs.map((source) => [evidenceRefKey(source), source] as const)
    )).entries()]
      .sort(([left], [right]) => RAW(left, right))
      .map(([, source]) => source)
  );
}

function document(
  nominationValue: Nomination,
  path: readonly ThreadRootedWitnessPathStep[],
  requestedScope: Scope,
  requestedSnapshot: Snapshot,
  requestedFreshness: Freshness
): Record<string, unknown> {
  const uniqueAssertions = [...new Map(path.map((step) => [
    step.assertion.id,
    step.assertion
  ])).values()].sort((left, right) => RAW(left.id, right.id));
  const body: Record<string, unknown> = {
    authority: {
      action: "no-authority-granted",
      freshness: requestedSnapshot.authority === "receipt-integrity-only"
        ? requestedSnapshot.kind === "process-local-provider-head-revalidation"
          ? "provider-head-revalidation-receipt-integrity-only"
          : "provider-capture-freshness-unassessed"
        : "caller-declared-not-verified",
      nomination: "caller-declared-non-exhaustive"
    },
    declaredFreshness: requestedFreshness,
    documentVersion: "muse.scoped-proof-document.v1",
    kind: nominationValue.kind,
    observedAt: nominationValue.observedAt,
    proof: {
      assertions: uniqueAssertions.map((assertion) => ({
        assertion,
        memberships: [requestedScope]
      })),
      paths: [path.map((step) => ({
        assertionId: step.assertion.id,
        direction: step.direction
      }))],
      sourceRefs: unionSources(path)
    },
    schemaVersion: 1,
    scope: requestedScope,
    semanticPriority: nominationValue.kind === "core"
      ? 0
      : nominationValue.kind === "change"
        ? 1
        : 2,
    snapshot: requestedSnapshot
  };
  const captured = canonicalizeImmutableEnvelope(
    mutableJson(body),
    "external-mutable",
    DOCUMENT_SPEC
  );
  return captured.envelope as Record<string, unknown>;
}

function captureRequest(input: unknown): Record<string, unknown> {
  try {
    return canonicalizeImmutableEnvelope(
      input,
      "external-mutable",
      ADMISSION_SPEC
    ).envelope as Record<string, unknown>;
  } catch (cause) {
    if (cause instanceof CanonicalImmutableEnvelopeError) {
      fail("invalid-request-envelope", cause.details.path);
    }
    throw cause;
  }
}

function captureReceipt(body: Record<string, unknown>): ThreadRootedWitnessReceiptV1 {
  try {
    const first = canonicalizeImmutableEnvelope(
      mutableJson(body),
      "external-mutable",
      RECEIPT_SPEC
    );
    const second = canonicalizeImmutableEnvelope(first.envelope, "attunegraph-frozen", RECEIPT_SPEC);
    if (
      first.contentId !== second.contentId
      || first.canonicalJson !== second.canonicalJson
      || first.canonicalByteLength !== second.canonicalByteLength
    ) {
      internal("receipt-postcondition-failed");
    }
    return second.envelope as unknown as ThreadRootedWitnessReceiptV1;
  } catch (cause) {
    if (cause instanceof ThreadRootedWitnessDocumentsError) throw cause;
    internal("receipt-postcondition-failed");
  }
}

function captureRetainedEnvelope<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
  spec: typeof RETAINED_ENTRY_SPEC | typeof RETAINED_MANIFEST_SPEC,
  idPattern: RegExp,
  reason: string
): T {
  try {
    const first = canonicalizeImmutableEnvelope(
      mutableJson(body),
      "external-mutable",
      spec
    );
    const second = canonicalizeImmutableEnvelope(
      first.envelope,
      "attunegraph-frozen",
      spec
    );
    if (
      first.contentId !== second.contentId
      || first.canonicalJson !== second.canonicalJson
      || first.canonicalByteLength !== second.canonicalByteLength
      || !idPattern.test(second.contentId)
    ) {
      internal(reason);
    }
    return second.envelope as T;
  } catch (cause) {
    if (cause instanceof ThreadRootedWitnessDocumentsError) throw cause;
    internal(reason);
  }
}

function internalRecord(value: unknown, reason: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    internal(reason);
  }
  return value as Record<string, unknown>;
}

function internalArray(value: unknown, reason: string): readonly unknown[] {
  if (!Array.isArray(value)) internal(reason);
  return value;
}

function assertRetainedFocus(
  documentValue: Readonly<Record<string, unknown>>,
  focusAssertion: GraphAssertion,
  expectedDocumentId: string,
  expectedFocusAssertionId: string,
  expectedDigest: string
): void {
  if (
    documentValue.documentId !== expectedDocumentId
    || focusAssertion.id !== expectedFocusAssertionId
    || domainDigest(FOCUS_ASSERTION_DIGEST_DOMAIN, focusAssertion)
      !== expectedDigest
  ) {
    internal("retained-focus-link-postcondition-failed");
  }
  const proof = internalRecord(
    documentValue.proof,
    "retained-focus-proof-postcondition-failed"
  );
  const paths = internalArray(
    proof.paths,
    "retained-focus-proof-postcondition-failed"
  );
  if (paths.length !== 1) {
    internal("retained-focus-proof-postcondition-failed");
  }
  const path = internalArray(
    paths[0],
    "retained-focus-proof-postcondition-failed"
  );
  const terminal = internalRecord(
    path.at(-1),
    "retained-focus-proof-postcondition-failed"
  );
  if (terminal.assertionId !== expectedFocusAssertionId) {
    internal("retained-focus-proof-postcondition-failed");
  }
  const proofAssertions = internalArray(
    proof.assertions,
    "retained-focus-proof-postcondition-failed"
  );
  const focused = proofAssertions
    .map((item) =>
      internalRecord(item, "retained-focus-proof-postcondition-failed")
    )
    .find((item) =>
      internalRecord(
        item.assertion,
        "retained-focus-proof-postcondition-failed"
      ).id === expectedFocusAssertionId
    );
  if (
    focused === undefined
    || canonicalValue(focused.assertion) !== canonicalValue(focusAssertion)
  ) {
    internal("retained-focus-proof-postcondition-failed");
  }
}

type RetainedCandidateMaterial = Readonly<{
  readonly document: Readonly<Record<string, unknown>>;
  readonly focusAssertion: GraphAssertion;
  readonly nomination: Nomination;
}>;

function buildRetainedWitnessInventory(value: Readonly<{
  readonly core: RetainedCandidateMaterial;
  readonly declaredFreshness: Freshness;
  readonly frontier: FairWitnessFrontierCompositionV1;
  readonly optionals: readonly RetainedCandidateMaterial[];
  readonly requestId: string;
  readonly scope: Scope;
  readonly seed: Readonly<{ readonly id: string; readonly kind: "thread" }>;
  readonly snapshot: Snapshot;
  readonly threadDispositions: readonly ThreadRootedWitnessDisposition[];
}>): ThreadRootedRetainedWitnessInventoryV1 {
  const coreDocumentId = value.core.document.documentId;
  if (
    typeof coreDocumentId !== "string"
    || value.frontier.receipt.coreDocumentId !== coreDocumentId
    || value.core.nomination.assertionId !== value.core.focusAssertion.id
  ) {
    internal("retained-core-link-postcondition-failed");
  }
  const coreFocusDigest = domainDigest(
    FOCUS_ASSERTION_DIGEST_DOMAIN,
    value.core.focusAssertion
  );
  const coreEntry =
    captureRetainedEnvelope<ThreadRootedRetainedWitnessCoreEntryV1>({
      assertionId: value.core.nomination.assertionId,
      candidateId: value.frontier.receipt.coreCandidateId,
      documentId: coreDocumentId,
      entryVersion: "muse.thread-rooted-retained-witness-entry.v1",
      focusAssertionDigest: coreFocusDigest,
      focusAssertionId: value.core.focusAssertion.id,
      frontierCore: {
        candidateId: value.frontier.receipt.coreCandidateId,
        documentId: value.frontier.receipt.coreDocumentId
      },
      nominationId: value.core.nomination.nominationId,
      observedAt: value.core.nomination.observedAt,
      role: "core",
      schemaVersion: 1
    }, RETAINED_ENTRY_SPEC, RETAINED_ENTRY_ID, "retained-entry-postcondition-failed");
  assertRetainedFocus(
    value.core.document,
    value.core.focusAssertion,
    coreEntry.documentId,
    coreEntry.focusAssertionId,
    coreEntry.focusAssertionDigest
  );

  const dispositionByNomination = new Map(
    value.frontier.receipt.dispositions.map((item) => [item.nominationId, item])
  );
  const optionalRegistry = [...value.optionals]
    .sort((left, right) =>
      RAW(left.nomination.nominationId, right.nomination.nominationId)
    )
    .map((item) => {
      const disposition = dispositionByNomination.get(
        item.nomination.nominationId
      );
      const documentId = item.document.documentId;
      if (
        disposition === undefined
        || typeof documentId !== "string"
        || disposition.documentId !== documentId
        || disposition.focusAssertionId !== item.focusAssertion.id
        || item.nomination.assertionId !== item.focusAssertion.id
      ) {
        internal("retained-optional-link-postcondition-failed");
      }
      const focusAssertionDigest = domainDigest(
        FOCUS_ASSERTION_DIGEST_DOMAIN,
        item.focusAssertion
      );
      const entry =
        captureRetainedEnvelope<ThreadRootedRetainedWitnessOptionalEntryV1>({
          assertionId: item.nomination.assertionId,
          candidateId: disposition.candidateId,
          documentId,
          entryVersion: "muse.thread-rooted-retained-witness-entry.v1",
          focusAssertionDigest,
          focusAssertionId: item.focusAssertion.id,
          frontierDisposition: disposition,
          nominationId: item.nomination.nominationId,
          observedAt: item.nomination.observedAt,
          role: "optional",
          schemaVersion: 1
        }, RETAINED_ENTRY_SPEC, RETAINED_ENTRY_ID, "retained-entry-postcondition-failed");
      assertRetainedFocus(
        item.document,
        item.focusAssertion,
        entry.documentId,
        entry.focusAssertionId,
        entry.focusAssertionDigest
      );
      return freezeRecord({
        document: item.document,
        entry,
        focusAssertion: item.focusAssertion
      });
    });

  const entryByCandidate = new Map(optionalRegistry.map((item) => [
    item.entry.candidateId,
    item.entry
  ]));
  const fairOrderedOptionalEntryIds = value.frontier.order.entries.map(
    (orderEntry, rank) => {
      const entry = entryByCandidate.get(orderEntry.candidateId);
      const disposition = value.frontier.receipt.dispositions.find((item) =>
        item.candidateId === orderEntry.candidateId
      );
      if (
        orderEntry.rank !== rank
        || entry === undefined
        || disposition === undefined
        || disposition.status === "lane-undetermined"
        || disposition.rank !== rank
      ) {
        internal("retained-fair-order-postcondition-failed");
      }
      return entry.entryId;
    }
  );
  const laneUndeterminedEntryIds = optionalRegistry
    .filter((item) =>
      item.entry.frontierDisposition.status === "lane-undetermined"
    )
    .map((item) => item.entry.entryId);
  const fairSet = new Set(fairOrderedOptionalEntryIds);
  const laneSet = new Set(laneUndeterminedEntryIds);
  const entryIds = [coreEntry.entryId, ...optionalRegistry.map((item) =>
    item.entry.entryId
  )];
  const candidateIds = [
    coreEntry.candidateId,
    ...optionalRegistry.map((item) => item.entry.candidateId)
  ];
  const documentIds = [
    coreEntry.documentId,
    ...optionalRegistry.map((item) => item.entry.documentId)
  ];
  const witnessedThreadOptionals = value.threadDispositions.filter((item) =>
    item.role === "optional" && item.status === "witnessed"
  );
  if (
    optionalRegistry.length !== value.frontier.receipt.dispositions.length
    || optionalRegistry.length !== witnessedThreadOptionals.length
    || fairSet.size !== fairOrderedOptionalEntryIds.length
    || laneSet.size !== laneUndeterminedEntryIds.length
    || [...fairSet].some((id) => laneSet.has(id))
    || fairSet.size + laneSet.size !== optionalRegistry.length
    || new Set(entryIds).size !== entryIds.length
    || new Set(candidateIds).size !== candidateIds.length
    || new Set(documentIds).size !== documentIds.length
    || optionalRegistry.some((item) =>
      !fairSet.has(item.entry.entryId) && !laneSet.has(item.entry.entryId)
    )
  ) {
    internal("retained-inventory-conservation-postcondition-failed");
  }

  const manifest =
    captureRetainedEnvelope<ThreadRootedRetainedWitnessManifestV1>({
      coreEntryId: coreEntry.entryId,
      counts: {
        excludedThreadNominations: value.threadDispositions.filter((item) =>
          item.status === "excluded"
        ).length,
        fairOrderedOptionals: fairOrderedOptionalEntryIds.length,
        frontierDispositions: value.frontier.receipt.dispositions.length,
        laneUndeterminedOptionals: laneUndeterminedEntryIds.length,
        threadDispositions: value.threadDispositions.length,
        witnessedOptionals: optionalRegistry.length
      },
      declaredFreshness: value.declaredFreshness,
      fairOrderDigest: domainDigest(
        FAIR_ORDER_DIGEST_DOMAIN,
        value.frontier.order.entries
      ),
      fairOrderedOptionalEntryIds,
      frontierDispositionsDigest: domainDigest(
        FRONTIER_DISPOSITIONS_DIGEST_DOMAIN,
        value.frontier.receipt.dispositions
      ),
      frontierOrderId: value.frontier.order.orderId,
      frontierReceiptId: value.frontier.receipt.receiptId,
      frontierSettlementResultId: value.frontier.settlement.resultId,
      laneUndeterminedEntryIds,
      manifestVersion:
        "muse.thread-rooted-retained-witness-manifest.v1",
      requestId: value.requestId,
      schemaVersion: 1,
      scope: value.scope,
      seed: value.seed,
      snapshot: value.snapshot,
      threadDispositionsDigest: domainDigest(
        THREAD_DISPOSITIONS_DIGEST_DOMAIN,
        value.threadDispositions
      )
    }, RETAINED_MANIFEST_SPEC, RETAINED_MANIFEST_ID, "retained-manifest-postcondition-failed");
  const inventory = freezeTree(freezeRecord({
    manifest,
    registry: freezeRecord({
      core: freezeRecord({
        document: value.core.document,
        entry: coreEntry,
        focusAssertion: value.core.focusAssertion
      }),
      optionals: freezeArray(optionalRegistry)
    })
  })) as ThreadRootedRetainedWitnessInventoryV1;
  if (
    manifest.coreEntryId !== inventory.registry.core.entry.entryId
    || manifest.frontierReceiptId !== value.frontier.receipt.receiptId
    || manifest.frontierOrderId !== value.frontier.order.orderId
    || manifest.frontierSettlementResultId !== value.frontier.settlement.resultId
  ) {
    internal("retained-manifest-link-postcondition-failed");
  }
  return inventory;
}

function logicalRequestId(value: {
  readonly assertions: readonly ScopedAssertion[];
  readonly budget: Budget;
  readonly considered: number;
  readonly depth: number;
  readonly freshness: Freshness;
  readonly nominations: readonly Nomination[];
  readonly plan: GraphQueryPlan;
  readonly refs: readonly GraphRef[];
  readonly scope: Scope;
  readonly snapshot: Snapshot;
  readonly truncated: boolean;
  readonly visited: number;
}): string {
  const plan: Record<string, unknown> = {
    direction: value.plan.direction,
    maxAssertions: value.plan.maxAssertions,
    maxConsideredAssertions: value.plan.maxConsideredAssertions,
    maxDepth: value.plan.maxDepth,
    maxVisitedRefs: value.plan.maxVisitedRefs,
    predicates: [...value.plan.predicates].sort(RAW),
    seeds: [...value.plan.seeds]
  };
  if (value.plan.validAt !== undefined) plan.validAt = value.plan.validAt;
  if (value.plan.recordedAtOrBefore !== undefined) {
    plan.recordedAtOrBefore = value.plan.recordedAtOrBefore;
  }
  if (value.plan.epistemicClasses !== undefined) {
    plan.epistemicClasses = [...value.plan.epistemicClasses].sort(RAW);
  }
  if (value.plan.includeSuperseded !== undefined) {
    plan.includeSuperseded = value.plan.includeSuperseded;
  }
  const [core, ...optionals] = value.nominations;
  if (!core) internal("request-postcondition-failed");
  const body = {
    boundedResult: {
      assertions: [...value.assertions]
        .sort((left, right) => RAW(left.assertion.id, right.assertion.id))
        .map((item) => ({
          assertion: item.assertion,
          memberships: item.memberships
        })),
      diagnostics: {
        consideredAssertions: value.considered,
        maxDepthReached: value.depth,
        visitedRefs: value.visited
      },
      refs: [...value.refs].sort((left, right) =>
        RAW(graphRefKey(left), graphRefKey(right))
      ),
      truncated: value.truncated
    },
    budget: value.budget,
    declaredFreshness: value.freshness,
    nominations: {
      core,
      optionals: [...optionals].sort((left, right) =>
        RAW(left.nominationId, right.nominationId)
      )
    },
    operatorVersion: "muse.thread-rooted-witness-documents.v1",
    query: plan,
    schemaVersion: 1,
    scope: value.scope,
    snapshot: value.snapshot
  };
  return canonicalizeImmutableEnvelope(
    mutableJson(body),
    "external-mutable",
    REQUEST_SPEC
  ).contentId;
}

function dispositionReason(
  nominationValue: Nomination,
  all: ReadonlyMap<string, ScopedAssertion>,
  planEligible: ReadonlyMap<string, ScopedAssertion>,
  scopeEligible: ReadonlyMap<string, ScopedAssertion>,
  rootedPath: readonly ThreadRootedWitnessPathStep[] | undefined
): Extract<ThreadRootedWitnessDisposition, { status: "excluded" }>["reason"] | undefined {
  if (!all.has(nominationValue.assertionId)) return "not-in-bounded-result";
  if (!planEligible.has(nominationValue.assertionId)) return "not-plan-eligible";
  if (!scopeEligible.has(nominationValue.assertionId)) return "not-scope-eligible";
  if (!rootedPath) return "not-thread-rooted";
  return undefined;
}

export function compileThreadRootedWitnessDocuments(
  input: unknown
): ThreadRootedWitnessCompilationV1 {
  const captured = captureRequest(input);
  const root = record(
    captured,
    [
      "schemaVersion",
      "operatorVersion",
      "admissionId",
      "scope",
      "snapshot",
      "declaredFreshness",
      "query",
      "boundedResult",
      "nominations",
      "budget"
    ],
    ["requestId"],
    ""
  );
  if (root.schemaVersion !== 1) fail("invalid-schema-version", "/schemaVersion");
  if (root.operatorVersion !== "muse.thread-rooted-witness-documents.v1") {
    fail("invalid-operator-version", "/operatorVersion");
  }
  const requestedScope = scope(root.scope, "/scope");
  const requestedSnapshot = snapshot(root.snapshot, "/snapshot");
  const requestedFreshness = freshness(root.declaredFreshness, "/declaredFreshness");
  snapshotFreshnessPair(
    requestedSnapshot,
    requestedFreshness,
    requestedScope
  );
  const plan = normalizedPlan(root.query);
  if (
    plan.seeds.length !== 1
    || plan.seeds[0]?.kind !== "thread"
    || plan.seeds[0].id !== (
      requestedSnapshot.authority === "receipt-integrity-only"
      && requestedSnapshot.kind
        === "process-local-provider-head-revalidation"
        ? continuityThreadGraphRef(requestedScope).id
        : requestedScope.threadId
    )
  ) {
    fail("scope-seed-mismatch", "/query/seeds");
  }
  const seed = plan.seeds[0];
  const result = record(
    root.boundedResult,
    ["assertions", "refs", "diagnostics", "truncated"],
    [],
    "/boundedResult"
  );
  if (typeof result.truncated !== "boolean") {
    fail("invalid-boolean", "/boundedResult/truncated");
  }
  const rawAssertions = array(
    result.assertions,
    MAX_ASSERTIONS,
    "/boundedResult/assertions"
  );
  const assertions = rawAssertions.map((item, index) =>
    scopedAssertion(item, `/boundedResult/assertions/${index.toString()}`)
  );
  const assertionIds = assertions.map((item) => item.assertion.id);
  if (new Set(assertionIds).size !== assertionIds.length) {
    fail("duplicate-assertion-id", "/boundedResult/assertions");
  }
  if (assertions.length > plan.maxAssertions) {
    fail("result-budget-mismatch", "/boundedResult/assertions");
  }
  const refs = array(result.refs, plan.maxVisitedRefs, "/boundedResult/refs")
    .map((item, index) => normalizeRef(item, `/boundedResult/refs/${index.toString()}`));
  const refKeys = refs.map(graphRefKey);
  if (new Set(refKeys).size !== refKeys.length || !refKeys.includes(graphRefKey(seed))) {
    fail("invalid-result-refs", "/boundedResult/refs");
  }
  const diagnostics = record(
    result.diagnostics,
    ["consideredAssertions", "maxDepthReached", "visitedRefs"],
    [],
    "/boundedResult/diagnostics"
  );
  const considered = safeInteger(
    diagnostics.consideredAssertions,
    "/boundedResult/diagnostics/consideredAssertions"
  );
  const depth = safeInteger(
    diagnostics.maxDepthReached,
    "/boundedResult/diagnostics/maxDepthReached"
  );
  const visited = safeInteger(
    diagnostics.visitedRefs,
    "/boundedResult/diagnostics/visitedRefs"
  );
  if (
    considered > plan.maxConsideredAssertions
    || depth > plan.maxDepth
    || visited !== refs.length
    || visited > plan.maxVisitedRefs
  ) {
    fail("result-budget-mismatch", "/boundedResult/diagnostics");
  }
  const nominationsRoot = record(
    root.nominations,
    ["core", "optionals"],
    [],
    "/nominations"
  );
  const core = nomination(nominationsRoot.core, "core", "/nominations/core");
  const optionals = array(
    nominationsRoot.optionals,
    MAX_OPTIONALS,
    "/nominations/optionals"
  ).map((item, index) =>
    nomination(item, "optional", `/nominations/optionals/${index.toString()}`)
  );
  const nominations = [core, ...optionals];
  if (
    (requestedFreshness.status === "fresh" || requestedFreshness.status === "stale")
    && nominations.some((item) =>
      instantEpoch(item.observedAt) > instantEpoch(requestedFreshness.observedAt)
    )
  ) {
    fail("freshness-mismatch", "/nominations");
  }
  const nominationIds = nominations.map((item) => item.nominationId);
  const nominatedAssertions = nominations.map((item) => item.assertionId);
  if (
    new Set(nominationIds).size !== nominationIds.length
    || new Set(nominatedAssertions).size !== nominatedAssertions.length
  ) {
    fail("duplicate-nomination", "/nominations");
  }
  const requestedBudget = budget(root.budget, "/budget");
  const requestId = logicalRequestId({
    assertions,
    budget: requestedBudget,
    considered,
    depth,
    freshness: requestedFreshness,
    nominations,
    plan,
    refs,
    scope: requestedScope,
    snapshot: requestedSnapshot,
    truncated: result.truncated,
    visited
  });
  if (
    root.requestId !== undefined
    && (typeof root.requestId !== "string"
      || !REQUEST_ID.test(root.requestId)
      || root.requestId !== requestId)
  ) {
    fail("invalid-request-id", "/requestId");
  }
  const all = new Map(assertions.map((item) => [item.assertion.id, item]));
  const planEligible = new Map(
    assertions
      .filter((item) => assertionMatchesPlan(item.assertion, plan))
      .map((item) => [item.assertion.id, item])
  );
  const scopeEligible = new Map(
    [...planEligible.values()]
      .filter((item) => item.memberships.some((member) =>
        sameScope(member, requestedScope)
      ))
      .map((item) => [item.assertion.id, item])
  );
  const eligibleAssertions = [...scopeEligible.values()].map((item) => item.assertion);
  const paths = new Map(nominations.map((item) => [
    item.nominationId,
    findThreadRootedWitnessPath(
      seed,
      item.assertionId,
      eligibleAssertions,
      plan.direction,
      plan.maxDepth
    )
  ]));
  const documents = new Map<string, Record<string, unknown>>();
  const dispositions: ThreadRootedWitnessDisposition[] = [];
  for (const [index, nominationValue] of nominations.entries()) {
    const role = index === 0 ? "core" as const : "optional" as const;
    const path = paths.get(nominationValue.nominationId);
    const reason = dispositionReason(
      nominationValue,
      all,
      planEligible,
      scopeEligible,
      path
    );
    if (reason) {
      dispositions.push(freezeRecord({
        assertionId: nominationValue.assertionId,
        nominationId: nominationValue.nominationId,
        reason,
        role,
        status: "excluded" as const
      }));
      continue;
    }
    if (!path) internal("path-postcondition-failed");
    const value = document(
      nominationValue,
      path,
      requestedScope,
      requestedSnapshot,
      requestedFreshness
    );
    const documentId = value.documentId;
    if (typeof documentId !== "string") internal("document-postcondition-failed");
    documents.set(nominationValue.nominationId, value);
    dispositions.push(freezeRecord({
      assertionId: nominationValue.assertionId,
      documentId,
      nominationId: nominationValue.nominationId,
      role,
      status: "witnessed" as const
    }));
  }
  dispositions.sort((left, right) =>
    left.role === right.role
      ? RAW(left.nominationId, right.nominationId)
      : left.role === "core" ? -1 : 1
  );
  const coreDocument = documents.get(core.nominationId);
  let frontier: FairWitnessFrontierCompositionV1 | undefined;
  let retainedInventory: ThreadRootedRetainedWitnessInventoryV1 | undefined;
  let settlement: ScopedProofDocumentSettlementResultV1 | undefined;
  if (coreDocument) {
    const coreFocus = scopeEligible.get(core.assertionId)?.assertion;
    if (coreFocus === undefined) internal("focus-assertion-postcondition-failed");
    const witnessedOptionals = optionals.flatMap((item) => {
      const witnessDocument = documents.get(item.nominationId);
      const focus = scopeEligible.get(item.assertionId)?.assertion;
      if (witnessDocument === undefined) return [];
      if (focus === undefined) internal("focus-assertion-postcondition-failed");
      return [{
        document: witnessDocument,
        focusAssertion: focus,
        nomination: item,
        nominationId: item.nominationId,
        observedAt: item.observedAt
      }];
    });
    frontier = settleFairWitnessFrontier({
      budget: requestedBudget,
      coreDocument,
      declaredFreshness: requestedFreshness,
      optionals: witnessedOptionals,
      scope: requestedScope,
      seed: { id: seed.id, kind: "thread" },
      snapshot: requestedSnapshot,
      threadRootedRequestId: requestId
    });
    settlement = frontier.settlement;
    const excludedOptionalIds = new Set(dispositions
      .filter((item) => item.role === "optional" && item.status === "excluded")
      .map((item) => item.nominationId));
    const frontierOptionalIds = new Set(frontier.receipt.dispositions.map((item) =>
      item.nominationId
    ));
    if (
      excludedOptionalIds.size + frontierOptionalIds.size !== optionals.length
      || [...excludedOptionalIds].some((id) => frontierOptionalIds.has(id))
      || optionals.some((item) =>
        !excludedOptionalIds.has(item.nominationId)
        && !frontierOptionalIds.has(item.nominationId)
      )
    ) {
      internal("frontier-conservation-postcondition-failed");
    }
    retainedInventory = buildRetainedWitnessInventory({
      core: {
        document: coreDocument,
        focusAssertion: coreFocus,
        nomination: core
      },
      declaredFreshness: requestedFreshness,
      frontier,
      optionals: witnessedOptionals,
      requestId,
      scope: requestedScope,
      seed: { id: seed.id, kind: "thread" },
      snapshot: requestedSnapshot,
      threadDispositions: dispositions
    });
  }
  const status = coreDocument && settlement?.status === "partial"
    ? "partial" as const
    : "abstained" as const;
  const excluded = dispositions.some((item) => item.status === "excluded");
  const reasons: ThreadRootedWitnessReceiptV1["coverage"]["reasons"][number][] = [
    requestedSnapshot.authority === "receipt-integrity-only"
      ? requestedSnapshot.kind === "process-local-provider-head-revalidation"
        ? "provider-head-revalidation-snapshot-integrity-only"
        : "provider-capture-snapshot-integrity-only"
      : "caller-declared-snapshot",
    ...(requestedFreshness.status === "unassessed"
      ? ["freshness-unassessed" as const]
      : "basis" in requestedFreshness
        ? ["fresh-at-assessment-only" as const]
        : []),
    result.truncated ? "traversal-truncated" : "bounded-result-only"
  ];
  if (excluded) reasons.push("nomination-excluded");
  if (!coreDocument) reasons.push("core-witness-unavailable");
  const receiptBody: Record<string, unknown> = {
    coverage: {
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons,
      status: "partial"
    },
    declaredFreshness: requestedFreshness,
    dispositions,
    receiptVersion: "muse.thread-rooted-witness-receipt.v1",
    requestId,
    schemaVersion: 1,
    scope: requestedScope,
    snapshot: requestedSnapshot,
    status
  };
  if (frontier) receiptBody.frontierReceiptId = frontier.receipt.receiptId;
  if (settlement) receiptBody.settlementResultId = settlement.resultId;
  const receipt = captureReceipt(receiptBody);
  if (!RECEIPT_ID.test(receipt.receiptId)) {
    internal("receipt-postcondition-failed");
  }
  const compilation = freezeTree(freezeRecord({
    ...(frontier ? {
      frontier: freezeRecord({
        order: frontier.order,
        receipt: frontier.receipt
      })
    } : {}),
    receipt,
    ...(settlement ? { settlement } : {}),
    status
  })) as ThreadRootedWitnessCompilationV1;
  if (retainedInventory) {
    retainedWitnessInventories.set(compilation, retainedInventory);
  }
  return compilation;
}
