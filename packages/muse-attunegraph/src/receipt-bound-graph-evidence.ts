import { types as nodeTypes } from "node:util";

import {
  compileActivationSubgraph
} from "@attunegraph/core";
import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "@attunegraph/core/extension-kit";
import {
  ACTIVATION_PREDICATES,
  MAX_GRAPH_QUERY_ASSERTIONS
} from "@attunegraph/core";
import {
  ContinuityObservationError,
  type ContinuityObservationReceipt,
  verifyContinuityObservation
} from "./continuity-observation.js";
import {
  continuityThreadGraphRef,
  type ContinuityProjectionScope
} from "./continuity-projection.js";
import { AttuneGraphDataError } from "@attunegraph/core";
import {
  type FairWitnessFrontierDisposition
} from "./fair-witness-frontier-settlement.js";
import { InMemoryAttuneGraphDataStore } from "@attunegraph/core";
import {
  GraphSnapshotProvenanceError,
  assertGraphSnapshotFreshnessScopePair,
  parseGraphDeclaredFreshness,
  parseGraphSnapshotProvenance,
  type GraphDeclaredFreshnessV1,
  type GraphSnapshotProvenanceV1
} from "./graph-snapshot-provenance.js";
import {
  ThreadRootedWitnessDocumentsError,
  type ThreadRootedWitnessCompilationV1,
  type ThreadRootedWitnessDisposition,
  compileThreadRootedWitnessDocuments
} from "./thread-rooted-witness-documents.js";
import {
  findThreadRootedWitnessPath,
  type ThreadRootedWitnessPathStep
} from "@attunegraph/core/extension-kit";
import type {
  ActivationSubgraph,
  AttuneGraphDataStore,
  GraphAppendReceipt,
  GraphAssertion,
  GraphForgetReceipt,
  GraphForgetScope,
  GraphQueryPlan,
  GraphRecordedRange,
  GraphRef,
  GraphTraversalResult,
  GraphVerification
} from "@attunegraph/core";

const ADMISSION_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.receipt-bound-graph-evidence-admission.v1",
  idField: "admissionId",
  idPrefix: "muse-attunegraph-receipt-bound-graph-admission:sha256:"
} as const);
const ACTIVATION_EVIDENCE_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.receipt-bound-activation-evidence.v1",
  idField: "evidenceId",
  idPrefix: "muse-attunegraph-receipt-bound-activation-evidence:sha256:"
} as const);
const RECEIPT_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.receipt-bound-graph-evidence-receipt.v1",
  idField: "receiptId",
  idPrefix: "muse-attunegraph-receipt-bound-graph-evidence-receipt:sha256:"
} as const);

const ADMISSION_ID =
  /^muse-attunegraph-receipt-bound-graph-admission:sha256:[0-9a-f]{64}$/u;
const ACTIVATION_EVIDENCE_ID =
  /^muse-attunegraph-receipt-bound-activation-evidence:sha256:[0-9a-f]{64}$/u;
const RECEIPT_ID =
  /^muse-attunegraph-receipt-bound-graph-evidence-receipt:sha256:[0-9a-f]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NOMINATION_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const ACTUAL_SEED_ID = /^muse-continuity-thread:[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const MAX_OPTIONALS = 255;
const RAW = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

type SnapshotV1 = GraphSnapshotProvenanceV1;
type FreshnessV1 = GraphDeclaredFreshnessV1;

type LegacyBudgetV1 = Readonly<{
  readonly maxAssertions: number;
  readonly maxConsideredAssertions: number;
  readonly maxDepth: number;
  readonly maxEstimatedTokens: number;
  readonly maxOutputBytes: number;
  readonly maxVisitedRefs: number;
}>;

type NominationRole = "core" | "change" | "support";

type NominationV1 = Readonly<{
  readonly assertionId: string;
  readonly nominationId: string;
  readonly role: NominationRole;
}>;

type PreparedNomination = NominationV1 & Readonly<{
  readonly path: string;
}>;

type LegacyExclusionReason =
  | "not-in-bounded-result"
  | "not-plan-eligible"
  | "not-scope-eligible"
  | "not-thread-rooted";

type LegacyAdmissionStatus =
  | "lane-undetermined"
  | "capacity-excluded"
  | "core-not-admitted"
  | "capacity-invalid"
  | "not-evaluated-core-unavailable";

type SubmittedDisposition =
  | Readonly<{
      readonly assertionId: string;
      readonly legacyDocumentId: string;
      readonly nominationId: string;
      readonly representativeNominationId: string;
      readonly role: NominationRole;
      readonly status: "submitted-admitted";
    }>
  | Readonly<{
      readonly assertionId: string;
      readonly legacyAdmissionStatus: LegacyAdmissionStatus;
      readonly legacyDocumentId: string;
      readonly nominationId: string;
      readonly representativeNominationId: string;
      readonly role: NominationRole;
      readonly status: "submitted-not-admitted";
    }>
  | Readonly<{
      readonly assertionId: string;
      readonly legacyExclusionReason: LegacyExclusionReason;
      readonly nominationId: string;
      readonly representativeNominationId: string;
      readonly role: NominationRole;
      readonly status: "submitted-excluded";
    }>;

export type ReceiptBoundGraphEvidenceDisposition =
  | SubmittedDisposition
  | Readonly<Omit<
      Extract<SubmittedDisposition, { readonly status: "submitted-admitted" }>,
      "status"
    > & { readonly status: "reused-admitted" }>
  | Readonly<Omit<
      Extract<SubmittedDisposition, { readonly status: "submitted-not-admitted" }>,
      "status"
    > & { readonly status: "reused-not-admitted" }>
  | Readonly<Omit<
      Extract<SubmittedDisposition, { readonly status: "submitted-excluded" }>,
      "status"
    > & { readonly status: "reused-excluded" }>;

export type ActivationEvidenceV1 = Readonly<{
  readonly activation: ActivationSubgraph;
  readonly evidenceId: string;
  readonly evidenceVersion: "muse.receipt-bound-activation-evidence.v1";
  readonly plan: GraphQueryPlan;
  readonly schemaVersion: 1;
  readonly traversal: GraphTraversalResult;
}>;

type CoverageReason =
  | "caller-declared-observation"
  | "provider-head-revalidated-observation-integrity-only"
  | "fresh-at-assessment-only"
  | "source-authority-unverified"
  | "freshness-unassessed"
  | "bounded-activation-only"
  | "legacy-payload-budget-only"
  | "non-authoritative-compatibility-scope"
  | "activation-truncated"
  | "nomination-reused"
  | "nomination-excluded"
  | "legacy-settlement-abstained";

export type ReceiptBoundGraphEvidenceReceiptV1 = Readonly<{
  readonly activationEvidenceId: string;
  readonly actualSeed: GraphRef;
  readonly authority: "receipt-integrity-only";
  readonly compatibilityScope: ContinuityProjectionScope;
  readonly compatibilitySemantics: "non-authoritative-v1-scope-compatibility";
  readonly coverage: Readonly<{
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly reasons: readonly CoverageReason[];
    readonly status: "partial" | "abstained";
  }>;
  readonly dispositions: readonly ReceiptBoundGraphEvidenceDisposition[];
  readonly legacyFrontierReceiptId?: string;
  readonly legacyOrderId?: string;
  readonly legacySettlementResultId?: string;
  readonly legacyWitnessReceiptId: string;
  readonly receiptId: string;
  readonly receiptVersion: "muse.receipt-bound-graph-evidence-receipt.v1";
  readonly schemaVersion: 1;
  readonly sourceObservationReceiptId: string;
  readonly sourceProjectionVersion: string;
  readonly sourceScope: ContinuityProjectionScope;
  readonly status: "partial" | "abstained";
}>;

export type ReceiptBoundGraphEvidenceV1 = Readonly<{
  readonly activationEvidence: ActivationEvidenceV1;
  readonly legacyCompilation: ThreadRootedWitnessCompilationV1;
  readonly receipt: ReceiptBoundGraphEvidenceReceiptV1;
}>;

export type ReceiptBoundGraphEvidenceErrorCode =
  | "INVALID_INPUT"
  | "DEPENDENCY_MISMATCH"
  | "CAPACITY_EXCEEDED"
  | "INTERNAL_POSTCONDITION_FAILED";

export type ReceiptBoundGraphEvidenceErrorReason =
  | "invalid-request-envelope"
  | "invalid-field-set"
  | "invalid-schema-version"
  | "invalid-operator-version"
  | "invalid-scope"
  | "invalid-instant"
  | "invalid-snapshot"
  | "invalid-freshness"
  | "invalid-nominations"
  | "invalid-legacy-budget"
  | "observation-receipt-invalid"
  | "observation-receipt-integrity-mismatch"
  | "scope-receipt-mismatch"
  | "cutoff-after-observation"
  | "nomination-off-receipt"
  | "nomination-not-admissible"
  | "graph-append-failed"
  | "activation-failed"
  | "legacy-compilation-failed"
  | "traversal-count-mismatch"
  | "traversal-plan-mismatch"
  | "receipt-assertion-mismatch"
  | "activation-assertion-mismatch"
  | "seed-mismatch"
  | "path-witness-mismatch"
  | "admission-disposition-mismatch"
  | "result-envelope-capacity-exceeded"
  | "result-postcondition-failed";

export class ReceiptBoundGraphEvidenceError extends Error {
  readonly code: ReceiptBoundGraphEvidenceErrorCode;
  readonly details: Readonly<{
    readonly path: string;
    readonly reason: ReceiptBoundGraphEvidenceErrorReason;
  }>;

  constructor(
    code: ReceiptBoundGraphEvidenceErrorCode,
    reason: ReceiptBoundGraphEvidenceErrorReason,
    path: string
  ) {
    super("receipt-bound-graph-evidence-failed");
    this.name = "ReceiptBoundGraphEvidenceError";
    this.code = code;
    this.details = Object.freeze({ path: boundedPath(path), reason });
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

/** Package-private test seam; not exported from the package root or export map. */
export class CapturingAttuneGraphDataStore implements AttuneGraphDataStore {
  plan: GraphQueryPlan | undefined;
  result: GraphTraversalResult | undefined;
  traversals = 0;

  constructor(private readonly delegate: AttuneGraphDataStore) {}

  append(assertions: readonly GraphAssertion[]): Promise<GraphAppendReceipt> {
    return this.delegate.append(assertions);
  }

  forget(scopeValue: GraphForgetScope): Promise<GraphForgetReceipt> {
    return this.delegate.forget(scopeValue);
  }

  getAssertion(id: string): Promise<GraphAssertion | undefined> {
    return this.delegate.getAssertion(id);
  }

  journal(): Promise<readonly GraphAssertion[]> {
    return this.delegate.journal();
  }

  recorded(range: GraphRecordedRange): Promise<readonly GraphAssertion[]> {
    return this.delegate.recorded(range);
  }

  async traverse(plan: GraphQueryPlan): Promise<GraphTraversalResult> {
    if (this.traversals !== 0) {
      throw new AttuneGraphDataError(
        "INVALID_QUERY",
        "receipt-bound graph evidence permits exactly one traversal"
      );
    }
    this.traversals += 1;
    this.plan = plan;
    const result = await this.delegate.traverse(plan);
    this.result = result;
    return result;
  }

  verify(): Promise<GraphVerification> {
    return this.delegate.verify();
  }
}

function boundedPath(path: string): string {
  return Buffer.byteLength(path, "utf8") <= 512 ? path : "<path-too-long>";
}

function child(path: string, segment: string): string {
  const escaped = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return boundedPath(`${path}/${escaped}`);
}

function fail(
  code: ReceiptBoundGraphEvidenceErrorCode,
  reason: ReceiptBoundGraphEvidenceErrorReason,
  path: string
): never {
  throw new ReceiptBoundGraphEvidenceError(code, reason, path);
}

function invalid(
  reason: ReceiptBoundGraphEvidenceErrorReason,
  path: string
): never {
  fail("INVALID_INPUT", reason, path);
}

function dependency(
  reason: ReceiptBoundGraphEvidenceErrorReason,
  path: string
): never {
  fail("DEPENDENCY_MISMATCH", reason, path);
}

function internal(
  reason: ReceiptBoundGraphEvidenceErrorReason,
  path: string
): never {
  fail("INTERNAL_POSTCONDITION_FAILED", reason, path);
}

function freezeRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
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

function exact(left: unknown, right: unknown): boolean {
  return canonicalValue(left) === canonicalValue(right);
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  reason: ReceiptBoundGraphEvidenceErrorReason
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(reason, path);
  }
  const keys = Reflect.ownKeys(value);
  const permitted = new Set([...required, ...optional]);
  if (
    keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => typeof key === "string" && !permitted.has(key))
  ) {
    invalid(reason, path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) =>
    typeof key !== "string"
    || descriptors[key] === undefined
    || !("value" in descriptors[key])
  )) {
    invalid(reason, path);
  }
  return value as Record<string, unknown>;
}

function array(
  value: unknown,
  maximum: number,
  path: string,
  reason: ReceiptBoundGraphEvidenceErrorReason
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(reason, path);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) =>
    typeof key !== "string"
    || (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key))
  )) {
    invalid(reason, path);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(reason, path);
  }
  return value;
}

function text(
  value: unknown,
  maximumCodePoints: number,
  path: string,
  reason: ReceiptBoundGraphEvidenceErrorReason
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > maximumCodePoints
    || CONTROL.test(value)
  ) {
    invalid(reason, path);
  }
  return value;
}

function utf8Text(
  value: unknown,
  maximumBytes: number,
  path: string,
  reason: ReceiptBoundGraphEvidenceErrorReason
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || CONTROL.test(value)
  ) {
    invalid(reason, path);
  }
  return value;
}

function instant(
  value: unknown,
  path: string,
  reason: ReceiptBoundGraphEvidenceErrorReason
): string {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    invalid(reason, path);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid(reason, path);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    invalid("invalid-legacy-budget", path);
  }
  return value as number;
}

function scope(value: unknown, path: string): ContinuityProjectionScope {
  const root = record(
    value,
    ["sourceId", "threadId"],
    [],
    path,
    "invalid-scope"
  );
  if (typeof root.sourceId !== "string" || !SOURCE_ID.test(root.sourceId)) {
    invalid("invalid-scope", child(path, "sourceId"));
  }
  return freezeRecord({
    sourceId: root.sourceId,
    threadId: utf8Text(
      root.threadId,
      512,
      child(path, "threadId"),
      "invalid-scope"
    )
  }) as ContinuityProjectionScope;
}

function snapshot(value: unknown, path: string): SnapshotV1 {
  try { return parseGraphSnapshotProvenance(value, path); }
  catch (cause) { if (cause instanceof GraphSnapshotProvenanceError) invalid("invalid-snapshot", cause.details.path); throw cause; }
}

function freshness(value: unknown, path: string): FreshnessV1 {
  try { return parseGraphDeclaredFreshness(value, path); }
  catch (cause) { if (cause instanceof GraphSnapshotProvenanceError) invalid("invalid-freshness", cause.details.path); throw cause; }
}

function legacyBudget(value: unknown, path: string): LegacyBudgetV1 {
  const fields = [
    "maxAssertions",
    "maxConsideredAssertions",
    "maxDepth",
    "maxEstimatedTokens",
    "maxOutputBytes",
    "maxVisitedRefs"
  ] as const;
  const root = record(value, fields, [], path, "invalid-legacy-budget");
  const maxAssertions = boundedInteger(
    root.maxAssertions,
    1,
    256,
    child(path, "maxAssertions")
  );
  const maxConsideredAssertions = boundedInteger(
    root.maxConsideredAssertions,
    maxAssertions,
    1_024,
    child(path, "maxConsideredAssertions")
  );
  return freezeRecord({
    maxAssertions,
    maxConsideredAssertions,
    maxDepth: boundedInteger(root.maxDepth, 0, 4, child(path, "maxDepth")),
    maxEstimatedTokens: boundedInteger(
      root.maxEstimatedTokens,
      64,
      32_768,
      child(path, "maxEstimatedTokens")
    ),
    maxOutputBytes: boundedInteger(
      root.maxOutputBytes,
      0,
      Number.MAX_SAFE_INTEGER,
      child(path, "maxOutputBytes")
    ),
    maxVisitedRefs: boundedInteger(
      root.maxVisitedRefs,
      1,
      1_024,
      child(path, "maxVisitedRefs")
    )
  });
}

function nomination(
  value: unknown,
  path: string,
  allowedRoles: readonly NominationRole[]
): PreparedNomination {
  const root = record(
    value,
    ["assertionId", "nominationId", "role"],
    [],
    path,
    "invalid-nominations"
  );
  const nominationId = text(
    root.nominationId,
    128,
    child(path, "nominationId"),
    "invalid-nominations"
  );
  if (!NOMINATION_ID.test(nominationId)) {
    invalid("invalid-nominations", child(path, "nominationId"));
  }
  if (!allowedRoles.includes(root.role as NominationRole)) {
    invalid("invalid-nominations", child(path, "role"));
  }
  return freezeRecord({
    assertionId: text(
      root.assertionId,
      512,
      child(path, "assertionId"),
      "invalid-nominations"
    ),
    nominationId,
    path,
    role: root.role as NominationRole
  });
}

function nominations(value: unknown, path: string): readonly PreparedNomination[] {
  const root = record(
    value,
    ["core", "optionals"],
    [],
    path,
    "invalid-nominations"
  );
  const core = nomination(
    root.core,
    child(path, "core"),
    ["core"]
  );
  const optionals = array(
    root.optionals,
    MAX_OPTIONALS,
    child(path, "optionals"),
    "invalid-nominations"
  ).map((item, index) =>
    nomination(
      item,
      `${child(path, "optionals")}/${index.toString()}`,
      ["change", "support"]
    )
  );
  const output = [core, ...optionals];
  if (new Set(output.map((item) => item.nominationId)).size !== output.length) {
    invalid("invalid-nominations", path);
  }
  return freezeArray(output);
}

function captureInput(input: unknown): Record<string, unknown> {
  let captured: ReturnType<typeof canonicalizeImmutableEnvelope>;
  try {
    captured = canonicalizeImmutableEnvelope(
      input,
      "external-mutable",
      ADMISSION_SPEC
    );
  } catch (cause) {
    if (isCanonicalError(cause)) {
      invalid("invalid-request-envelope", cause.details.path);
    }
    throw cause;
  }
  if (
    input !== null
    && typeof input === "object"
    && !nodeTypes.isProxy(input)
    && Reflect.getOwnPropertyDescriptor(input, "admissionId") !== undefined
  ) {
    invalid("invalid-field-set", "/admissionId");
  }
  if (!ADMISSION_ID.test(captured.contentId)) {
    internal("result-postcondition-failed", "/admissionId");
  }
  return captured.envelope as Record<string, unknown>;
}

function isCanonicalError(
  cause: unknown
): cause is CanonicalImmutableEnvelopeError {
  return cause instanceof CanonicalImmutableEnvelopeError
    || (
      cause instanceof Error
      && cause.name === "CanonicalImmutableEnvelopeError"
      && typeof (cause as { code?: unknown }).code === "string"
      && typeof (cause as { details?: { path?: unknown } }).details?.path === "string"
    );
}

function parseRequest(input: unknown): Readonly<{
  readonly budget: LegacyBudgetV1;
  readonly cutoff: string;
  readonly freshness: FreshnessV1;
  readonly nominations: readonly PreparedNomination[];
  readonly receiptInput: unknown;
  readonly scope: ContinuityProjectionScope;
  readonly snapshot: SnapshotV1;
}> {
  const captured = captureInput(input);
  const root = record(
    captured,
    [
      "schemaVersion",
      "operatorVersion",
      "scope",
      "currentGraphObservationReceipt",
      "recordedAtOrBefore",
      "snapshot",
      "declaredFreshness",
      "nominations",
      "legacyBudget",
      "admissionId"
    ],
    [],
    "",
    "invalid-field-set"
  );
  if (root.schemaVersion !== 1) {
    invalid("invalid-schema-version", "/schemaVersion");
  }
  if (root.operatorVersion !== "muse.receipt-bound-graph-evidence.v1") {
    invalid("invalid-operator-version", "/operatorVersion");
  }
  return freezeRecord({
    budget: legacyBudget(root.legacyBudget, "/legacyBudget"),
    cutoff: instant(
      root.recordedAtOrBefore,
      "/recordedAtOrBefore",
      "invalid-instant"
    ),
    freshness: freshness(root.declaredFreshness, "/declaredFreshness"),
    nominations: nominations(root.nominations, "/nominations"),
    receiptInput: root.currentGraphObservationReceipt,
    scope: scope(root.scope, "/scope"),
    snapshot: snapshot(root.snapshot, "/snapshot")
  });
}

function verifyReceipt(input: unknown): ContinuityObservationReceipt {
  try {
    return verifyContinuityObservation(input);
  } catch (cause) {
    if (cause instanceof ContinuityObservationError) {
      dependency(
        cause.code === "INTEGRITY_MISMATCH"
          ? "observation-receipt-integrity-mismatch"
          : "observation-receipt-invalid",
        "/currentGraphObservationReceipt"
      );
    }
    throw cause;
  }
}

function assertionMap(
  assertions: readonly GraphAssertion[],
  reason: ReceiptBoundGraphEvidenceErrorReason,
  path: string
): ReadonlyMap<string, GraphAssertion> {
  const output = new Map<string, GraphAssertion>();
  for (const assertion of assertions) {
    if (output.has(assertion.id)) internal(reason, path);
    output.set(assertion.id, assertion);
  }
  return output;
}

function assertExactAssertions(
  assertions: readonly GraphAssertion[],
  source: ReadonlyMap<string, GraphAssertion>,
  reason: ReceiptBoundGraphEvidenceErrorReason,
  path: string
): void {
  const seen = new Set<string>();
  for (const assertion of assertions) {
    const expected = source.get(assertion.id);
    if (
      seen.has(assertion.id)
      || expected === undefined
      || !exact(assertion, expected)
    ) {
      internal(reason, path);
    }
    seen.add(assertion.id);
  }
}

function assertCapturedPlan(
  plan: GraphQueryPlan,
  seed: GraphRef,
  receipt: ContinuityObservationReceipt,
  cutoff: string,
  budget: LegacyBudgetV1
): void {
  if (
    plan.seeds.length !== 1
    || !exact(plan.seeds[0], seed)
    || !exact(plan.predicates, ACTIVATION_PREDICATES)
    || plan.direction !== "both"
    || plan.maxAssertions !== Math.min(
      MAX_GRAPH_QUERY_ASSERTIONS,
      budget.maxConsideredAssertions
    )
    || plan.maxConsideredAssertions !== budget.maxConsideredAssertions
    || plan.maxDepth !== budget.maxDepth
    || plan.maxVisitedRefs !== budget.maxVisitedRefs
    || plan.validAt !== receipt.observedAt
    || plan.recordedAtOrBefore !== cutoff
    || plan.epistemicClasses !== undefined
    || plan.includeSuperseded !== undefined
  ) {
    internal("traversal-plan-mismatch", "/activationEvidence/plan");
  }
}

function representativeOrder(left: PreparedNomination, right: PreparedNomination): number {
  const priority: Readonly<Record<NominationRole, number>> = {
    core: 0,
    change: 1,
    support: 2
  };
  return priority[left.role] - priority[right.role]
    || RAW(left.nominationId, right.nominationId);
}

function representativeNominations(
  nominationsValue: readonly PreparedNomination[]
): Readonly<{
  readonly representatives: readonly PreparedNomination[];
  readonly representativeByNominationId: ReadonlyMap<string, PreparedNomination>;
}> {
  const groups = new Map<string, PreparedNomination[]>();
  for (const item of nominationsValue) {
    const group = groups.get(item.assertionId);
    if (group) group.push(item);
    else groups.set(item.assertionId, [item]);
  }
  const representatives = [...groups.values()]
    .map((group) => [...group].sort(representativeOrder)[0]!)
    .sort((left, right) =>
      left.role === "core"
        ? right.role === "core" ? 0 : -1
        : right.role === "core" ? 1 : RAW(left.nominationId, right.nominationId)
    );
  const byAssertion = new Map(
    representatives.map((item) => [item.assertionId, item])
  );
  return freezeRecord({
    representatives: freezeArray(representatives),
    representativeByNominationId: new Map(
      nominationsValue.map((item) => [
        item.nominationId,
        byAssertion.get(item.assertionId)!
      ])
    )
  });
}

function witnessDispositionMap(
  legacy: ThreadRootedWitnessCompilationV1
): ReadonlyMap<string, ThreadRootedWitnessDisposition> {
  return new Map(
    legacy.receipt.dispositions.map((item) => [item.nominationId, item])
  );
}

function frontierDispositionMap(
  legacy: ThreadRootedWitnessCompilationV1
): ReadonlyMap<string, FairWitnessFrontierDisposition> {
  return new Map(
    (legacy.frontier?.receipt.dispositions ?? [])
      .map((item) => [item.nominationId, item])
  );
}

function materializedDocuments(
  legacy: ThreadRootedWitnessCompilationV1
): ReadonlyMap<string, Record<string, unknown>> {
  if (legacy.settlement?.status !== "partial") return new Map();
  return new Map(
    legacy.settlement.documents.map((document) => [
      document.documentId,
      document as unknown as Record<string, unknown>
    ])
  );
}

function pathIdentity(path: readonly ThreadRootedWitnessPathStep[]): string {
  return JSON.stringify(path.map((step) => [step.assertion.id, step.direction]));
}

function documentPath(document: Record<string, unknown>): string | undefined {
  const proof = document.proof;
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)) {
    return undefined;
  }
  const paths = (proof as Record<string, unknown>).paths;
  if (!Array.isArray(paths) || paths.length !== 1 || !Array.isArray(paths[0])) {
    return undefined;
  }
  const steps: [string, string][] = [];
  for (const step of paths[0]) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) {
      return undefined;
    }
    const assertionId = (step as Record<string, unknown>).assertionId;
    const direction = (step as Record<string, unknown>).direction;
    if (
      typeof assertionId !== "string"
      || (direction !== "incoming" && direction !== "outgoing")
    ) {
      return undefined;
    }
    steps.push([assertionId, direction]);
  }
  return JSON.stringify(steps);
}

function submittedDisposition(
  representative: PreparedNomination,
  legacy: ThreadRootedWitnessCompilationV1,
  witness: ThreadRootedWitnessDisposition,
  frontier: FairWitnessFrontierDisposition | undefined,
  documents: ReadonlyMap<string, Record<string, unknown>>,
  expectedPath: readonly ThreadRootedWitnessPathStep[] | undefined
): SubmittedDisposition {
  const common = {
    assertionId: representative.assertionId,
    nominationId: representative.nominationId,
    representativeNominationId: representative.nominationId,
    role: representative.role
  } as const;
  if (witness.status === "excluded") {
    if (expectedPath !== undefined) {
      internal("path-witness-mismatch", representative.path);
    }
    if (frontier !== undefined) {
      internal("admission-disposition-mismatch", representative.path);
    }
    return freezeRecord({
      ...common,
      legacyExclusionReason: witness.reason,
      status: "submitted-excluded" as const
    });
  }
  if (expectedPath === undefined || witness.assertionId !== representative.assertionId) {
    internal("path-witness-mismatch", representative.path);
  }
  const document = documents.get(witness.documentId);
  if (document !== undefined) {
    const actualPath = documentPath(document);
    if (
      actualPath !== pathIdentity(expectedPath)
      || expectedPath.at(-1)?.assertion.id !== representative.assertionId
    ) {
      internal("path-witness-mismatch", representative.path);
    }
  }
  if (representative.role === "core") {
    if (
      legacy.status === "partial"
      && legacy.settlement?.status === "partial"
      && document !== undefined
    ) {
      return freezeRecord({
        ...common,
        legacyDocumentId: witness.documentId,
        status: "submitted-admitted" as const
      });
    }
    if (legacy.settlement?.status === "abstained") {
      return freezeRecord({
        ...common,
        legacyAdmissionStatus: "core-not-admitted" as const,
        legacyDocumentId: witness.documentId,
        status: "submitted-not-admitted" as const
      });
    }
    if (legacy.settlement?.status === "invalid-input") {
      return freezeRecord({
        ...common,
        legacyAdmissionStatus: "capacity-invalid" as const,
        legacyDocumentId: witness.documentId,
        status: "submitted-not-admitted" as const
      });
    }
    internal("admission-disposition-mismatch", representative.path);
  }
  if (legacy.frontier === undefined && legacy.settlement === undefined) {
    return freezeRecord({
      ...common,
      legacyAdmissionStatus: "not-evaluated-core-unavailable" as const,
      legacyDocumentId: witness.documentId,
      status: "submitted-not-admitted" as const
    });
  }
  if (frontier === undefined || frontier.documentId !== witness.documentId) {
    internal("admission-disposition-mismatch", representative.path);
  }
  if (frontier.status === "budget-admitted") {
    if (document === undefined) {
      internal("admission-disposition-mismatch", representative.path);
    }
    return freezeRecord({
      ...common,
      legacyDocumentId: witness.documentId,
      status: "submitted-admitted" as const
    });
  }
  return freezeRecord({
    ...common,
    legacyAdmissionStatus: frontier.status,
    legacyDocumentId: witness.documentId,
    status: "submitted-not-admitted" as const
  });
}

function reusedDisposition(
  nominationValue: PreparedNomination,
  representative: PreparedNomination,
  submitted: SubmittedDisposition
): ReceiptBoundGraphEvidenceDisposition {
  const common = {
    assertionId: nominationValue.assertionId,
    nominationId: nominationValue.nominationId,
    representativeNominationId: representative.nominationId,
    role: nominationValue.role
  };
  if (submitted.status === "submitted-admitted") {
    return freezeRecord({
      ...common,
      legacyDocumentId: submitted.legacyDocumentId,
      status: "reused-admitted" as const
    });
  }
  if (submitted.status === "submitted-not-admitted") {
    return freezeRecord({
      ...common,
      legacyAdmissionStatus: submitted.legacyAdmissionStatus,
      legacyDocumentId: submitted.legacyDocumentId,
      status: "reused-not-admitted" as const
    });
  }
  return freezeRecord({
    ...common,
    legacyExclusionReason: submitted.legacyExclusionReason,
    status: "reused-excluded" as const
  });
}

function captureArtifact<T>(
  body: Record<string, unknown>,
  spec: typeof ACTIVATION_EVIDENCE_SPEC | typeof RECEIPT_SPEC,
  path: "/activationEvidence" | "/receipt",
  idPattern: RegExp
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
      internal("result-postcondition-failed", path);
    }
    return second.envelope as T;
  } catch (cause) {
    if (cause instanceof ReceiptBoundGraphEvidenceError) throw cause;
    if (isCanonicalError(cause) && cause.code === "BUDGET_EXCEEDED") {
      fail("CAPACITY_EXCEEDED", "result-envelope-capacity-exceeded", path);
    }
    internal("result-postcondition-failed", path);
  }
}

function activationEvidence(
  plan: GraphQueryPlan,
  traversal: GraphTraversalResult,
  activation: ActivationSubgraph
): ActivationEvidenceV1 {
  return captureArtifact<ActivationEvidenceV1>({
    activation,
    evidenceVersion: "muse.receipt-bound-activation-evidence.v1",
    plan,
    schemaVersion: 1,
    traversal
  }, ACTIVATION_EVIDENCE_SPEC, "/activationEvidence", ACTIVATION_EVIDENCE_ID);
}

function assertLegacyLinks(
  legacy: ThreadRootedWitnessCompilationV1
): Readonly<{
  readonly legacyFrontierReceiptId?: string;
  readonly legacyOrderId?: string;
  readonly legacySettlementResultId?: string;
}> {
  const frontier = legacy.frontier;
  const settlement = legacy.settlement;
  if ((frontier === undefined) !== (settlement === undefined)) {
    internal("admission-disposition-mismatch", "/legacyCompilation");
  }
  if (!frontier || !settlement) {
    if (
      legacy.receipt.frontierReceiptId !== undefined
      || legacy.receipt.settlementResultId !== undefined
    ) {
      internal("admission-disposition-mismatch", "/legacyCompilation/receipt");
    }
    return freezeRecord({});
  }
  if (
    legacy.receipt.frontierReceiptId !== frontier.receipt.receiptId
    || legacy.receipt.settlementResultId !== settlement.resultId
  ) {
    internal("admission-disposition-mismatch", "/legacyCompilation/receipt");
  }
  return freezeRecord({
    legacyFrontierReceiptId: frontier.receipt.receiptId,
    legacyOrderId: frontier.order.orderId,
    legacySettlementResultId: settlement.resultId
  });
}

function orderedLogicalNominations(
  values: readonly PreparedNomination[]
): readonly PreparedNomination[] {
  const core = values.find((item) => item.role === "core");
  if (!core) internal("result-postcondition-failed", "/nominations/core");
  return freezeArray([
    core,
    ...values
      .filter((item) => item.role !== "core")
      .sort((left, right) => RAW(left.nominationId, right.nominationId))
  ]);
}

export async function compileReceiptBoundGraphEvidence(
  input: unknown
): Promise<ReceiptBoundGraphEvidenceV1> {
  const requested = parseRequest(input);
  try {
    assertGraphSnapshotFreshnessScopePair(
      requested.snapshot,
      requested.freshness,
      requested.scope,
      {
        snapshot: "/snapshot",
        freshness: "/declaredFreshness",
        expectedScope: "/scope"
      }
    );
  } catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) invalid("invalid-freshness", cause.details.path);
    throw cause;
  }
  const receipt = verifyReceipt(requested.receiptInput);
  if (!exact(requested.scope, receipt.projection.scope)) {
    dependency("scope-receipt-mismatch", "/scope");
  }
  if (Date.parse(requested.cutoff) > Date.parse(receipt.observedAt)) {
    dependency("cutoff-after-observation", "/recordedAtOrBefore");
  }
  if (
    (requested.freshness.status === "fresh"
      || requested.freshness.status === "stale")
    && requested.freshness.observedAt !== receipt.observedAt
  ) {
    invalid("invalid-freshness", "/declaredFreshness/observedAt");
  }
  const actualSeed = continuityThreadGraphRef(receipt.projection.scope);
  if (
    actualSeed.kind !== "thread"
    || !ACTUAL_SEED_ID.test(actualSeed.id)
  ) {
    internal("seed-mismatch", "/actualSeed");
  }
  const receiptAssertions = assertionMap(
    receipt.projection.assertions,
    "receipt-assertion-mismatch",
    "/currentGraphObservationReceipt/projection/assertions"
  );
  const admissibleAssertions = receipt.projection.assertions.filter((assertion) =>
    assertion.epistemicClass !== "model-hypothesis"
  );
  const admissible = assertionMap(
    admissibleAssertions,
    "receipt-assertion-mismatch",
    "/currentGraphObservationReceipt/projection/assertions"
  );
  for (const item of requested.nominations) {
    const assertion = receiptAssertions.get(item.assertionId);
    if (!assertion) {
      dependency("nomination-off-receipt", child(item.path, "assertionId"));
    }
    if (
      !admissible.has(item.assertionId)
      || Date.parse(assertion.recordedAt) > Date.parse(receipt.observedAt)
    ) {
      dependency("nomination-not-admissible", child(item.path, "assertionId"));
    }
  }
  const baseStore = new InMemoryAttuneGraphDataStore();
  try {
    await baseStore.append(admissibleAssertions);
  } catch {
    internal("graph-append-failed", "/currentGraphObservationReceipt/projection/assertions");
  }
  const store = new CapturingAttuneGraphDataStore(baseStore);
  let activation: ActivationSubgraph;
  try {
    activation = await compileActivationSubgraph(store, {
      budget: {
        maxAssertions: requested.budget.maxAssertions,
        maxConsideredAssertions: requested.budget.maxConsideredAssertions,
        maxDepth: requested.budget.maxDepth,
        maxEstimatedTokens: requested.budget.maxEstimatedTokens,
        maxVisitedRefs: requested.budget.maxVisitedRefs
      },
      now: receipt.observedAt,
      recordedAtOrBefore: requested.cutoff,
      seed: actualSeed
    });
  } catch {
    internal("activation-failed", "/activationEvidence/activation");
  }
  if (store.traversals !== 1 || !store.plan || !store.result) {
    internal("traversal-count-mismatch", "/activationEvidence");
  }
  const capturedPlan = store.plan;
  const traversal = store.result;
  assertCapturedPlan(
    capturedPlan,
    actualSeed,
    receipt,
    requested.cutoff,
    requested.budget
  );
  assertExactAssertions(
    traversal.assertions,
    admissible,
    "receipt-assertion-mismatch",
    "/activationEvidence/traversal/assertions"
  );
  assertExactAssertions(
    activation.assertions,
    admissible,
    "activation-assertion-mismatch",
    "/activationEvidence/activation/assertions"
  );
  if (
    !activation.refs.some((ref) => exact(ref, actualSeed))
    || !exact(activation.seed, actualSeed)
  ) {
    internal("seed-mismatch", "/activationEvidence/activation");
  }
  const compatibilityScope = freezeRecord({
    sourceId: receipt.projection.scope.sourceId,
    threadId: actualSeed.id
  }) as ContinuityProjectionScope;
  const headRevalidated =
    requested.snapshot.authority === "receipt-integrity-only"
    && requested.snapshot.kind
      === "process-local-provider-head-revalidation";
  const legacyScope = headRevalidated
    ? requested.scope
    : compatibilityScope;
  const representativeState = representativeNominations(requested.nominations);
  const coreRepresentative = representativeState.representatives
    .find((item) => item.role === "core");
  if (!coreRepresentative) {
    internal("result-postcondition-failed", "/nominations/core");
  }
  const optionalRepresentatives = representativeState.representatives
    .filter((item) => item.role !== "core");
  let legacy: ThreadRootedWitnessCompilationV1;
  try {
    legacy = compileThreadRootedWitnessDocuments(mutableJson({
      boundedResult: {
        assertions: activation.assertions.map((assertion) => ({
          assertion,
          memberships: [legacyScope]
        })),
        diagnostics: traversal.diagnostics,
        refs: traversal.refs,
        truncated: activation.truncated || traversal.truncated
      },
      budget: requested.budget,
      declaredFreshness: requested.freshness,
      nominations: {
        core: {
          assertionId: coreRepresentative.assertionId,
          kind: "core",
          nominationId: coreRepresentative.nominationId,
          observedAt: admissible.get(coreRepresentative.assertionId)!.recordedAt
        },
        optionals: optionalRepresentatives.map((item) => ({
          assertionId: item.assertionId,
          kind: item.role,
          nominationId: item.nominationId,
          observedAt: admissible.get(item.assertionId)!.recordedAt
        }))
      },
      operatorVersion: "muse.thread-rooted-witness-documents.v1",
      query: capturedPlan,
      schemaVersion: 1,
      scope: legacyScope,
      snapshot: requested.snapshot
    }));
  } catch (cause) {
    if (cause instanceof ThreadRootedWitnessDocumentsError) {
      internal("legacy-compilation-failed", "/legacyCompilation");
    }
    throw cause;
  }
  const witnesses = witnessDispositionMap(legacy);
  const frontiers = frontierDispositionMap(legacy);
  const documents = materializedDocuments(legacy);
  const submitted = new Map<string, SubmittedDisposition>();
  for (const representative of representativeState.representatives) {
    const witness = witnesses.get(representative.nominationId);
    if (!witness || witness.assertionId !== representative.assertionId) {
      internal("admission-disposition-mismatch", representative.path);
    }
    const expectedPath = findThreadRootedWitnessPath(
      actualSeed,
      representative.assertionId,
      activation.assertions,
      capturedPlan.direction,
      capturedPlan.maxDepth
    );
    submitted.set(
      representative.nominationId,
      submittedDisposition(
        representative,
        legacy,
        witness,
        frontiers.get(representative.nominationId),
        documents,
        expectedPath
      )
    );
  }
  if (witnesses.size !== representativeState.representatives.length) {
    internal("admission-disposition-mismatch", "/legacyCompilation/receipt/dispositions");
  }
  const expectedFrontierIds = new Set(
    legacy.frontier === undefined
      ? []
      : representativeState.representatives
        .filter((item) =>
          item.role !== "core"
          && witnesses.get(item.nominationId)?.status === "witnessed"
        )
        .map((item) => item.nominationId)
  );
  if (
    frontiers.size !== expectedFrontierIds.size
    || [...frontiers.keys()].some((id) => !expectedFrontierIds.has(id))
  ) {
    internal(
      "admission-disposition-mismatch",
      "/legacyCompilation/frontier/receipt/dispositions"
    );
  }
  const admittedDocumentIds = new Set(
    [...submitted.values()]
      .filter((item) => item.status === "submitted-admitted")
      .map((item) => item.legacyDocumentId)
  );
  if (
    documents.size !== admittedDocumentIds.size
    || [...documents.keys()].some((id) => !admittedDocumentIds.has(id))
  ) {
    internal("admission-disposition-mismatch", "/legacyCompilation/settlement");
  }
  const logicalDispositions = orderedLogicalNominations(requested.nominations)
    .map((item): ReceiptBoundGraphEvidenceDisposition => {
      const representative =
        representativeState.representativeByNominationId.get(item.nominationId);
      const representativeDisposition = representative
        ? submitted.get(representative.nominationId)
        : undefined;
      if (!representative || !representativeDisposition) {
        internal("admission-disposition-mismatch", item.path);
      }
      if (representative.nominationId === item.nominationId) {
        return representativeDisposition;
      }
      return reusedDisposition(item, representative, representativeDisposition);
    });
  const linkedActivation = activationEvidence(capturedPlan, traversal, activation);
  const status = legacy.status === "partial" ? "partial" as const : "abstained" as const;
  const reasons: CoverageReason[] = [
    ...(headRevalidated
      ? [
          "provider-head-revalidated-observation-integrity-only" as const,
          "fresh-at-assessment-only" as const,
          "source-authority-unverified" as const
        ]
      : [
          "caller-declared-observation" as const,
          "source-authority-unverified" as const,
          ...(requested.freshness.status === "unassessed"
            ? ["freshness-unassessed" as const]
            : [])
        ]),
    "bounded-activation-only",
    "legacy-payload-budget-only",
    "non-authoritative-compatibility-scope"
  ];
  if (activation.truncated || traversal.truncated) reasons.push("activation-truncated");
  if (logicalDispositions.some((item) => item.status.startsWith("reused-"))) {
    reasons.push("nomination-reused");
  }
  if (logicalDispositions.some((item) => item.status.endsWith("-excluded"))) {
    reasons.push("nomination-excluded");
  }
  if (legacy.status !== "partial") reasons.push("legacy-settlement-abstained");
  const links = assertLegacyLinks(legacy);
  const bindingReceipt = captureArtifact<ReceiptBoundGraphEvidenceReceiptV1>({
    activationEvidenceId: linkedActivation.evidenceId,
    actualSeed,
    authority: "receipt-integrity-only",
    compatibilityScope,
    compatibilitySemantics: "non-authoritative-v1-scope-compatibility",
    coverage: {
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons,
      status
    },
    dispositions: logicalDispositions,
    legacyWitnessReceiptId: legacy.receipt.receiptId,
    ...links,
    receiptVersion: "muse.receipt-bound-graph-evidence-receipt.v1",
    schemaVersion: 1,
    sourceObservationReceiptId: receipt.receiptId,
    sourceProjectionVersion: receipt.projection.projectionVersion,
    sourceScope: receipt.projection.scope,
    status
  }, RECEIPT_SPEC, "/receipt", RECEIPT_ID);
  if (
    bindingReceipt.coverage.status !== bindingReceipt.status
    || bindingReceipt.activationEvidenceId !== linkedActivation.evidenceId
  ) {
    internal("result-postcondition-failed", "/receipt");
  }
  return freezeTree(freezeRecord({
    activationEvidence: linkedActivation,
    legacyCompilation: legacy,
    receipt: bindingReceipt
  })) as ReceiptBoundGraphEvidenceV1;
}
