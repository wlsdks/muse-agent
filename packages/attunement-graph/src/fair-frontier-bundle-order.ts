import { types as nodeTypes } from "node:util";

import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import {
  GraphSnapshotProvenanceError,
  parseGraphSnapshotProvenance,
  type GraphSnapshotProvenanceV1
} from "./graph-snapshot-provenance.js";

const REQUEST_SPEC = Object.freeze({
  hashDomain: "muse.attunement-graph.fair-frontier-bundle-order-request.v1",
  idField: "requestId",
  idPrefix: "muse-fair-frontier-request:sha256:"
} as const);
const ADMISSION_SPEC = Object.freeze({
  hashDomain: "muse.attunement-graph.fair-frontier-bundle-order-admission.v1",
  idField: "admissionId",
  idPrefix: "muse-fair-frontier-admission:sha256:"
} as const);
const ORDER_SPEC = Object.freeze({
  hashDomain: "muse.attunement-graph.fair-frontier-bundle-order.v1",
  idField: "orderId",
  idPrefix: "muse-fair-frontier-order:sha256:"
} as const);

export const FAIR_FRONTIER_LANES = Object.freeze([
  "continuity",
  "change",
  "evidence",
  "policy",
  "authority"
] as const);

export type FairFrontierLane = typeof FAIR_FRONTIER_LANES[number];

type Scope = Readonly<{
  readonly sourceId: string;
  readonly threadId: string;
}>;
type Snapshot = GraphSnapshotProvenanceV1;
type Seed = Readonly<{ readonly id: string; readonly kind: "thread" }>;
type Opportunity = Readonly<{
  readonly bundleId: string;
  readonly candidateId: string;
  readonly lane: FairFrontierLane;
  readonly observedAt: string;
}>;

export type FairFrontierOrderedEntry = Opportunity & Readonly<{
  readonly rank: number;
}>;

export type FairFrontierLaneMetrics =
  | Readonly<{
      readonly lane: FairFrontierLane;
      readonly opportunityCount: 0;
      readonly orderedCount: 0;
    }>
  | Readonly<{
      readonly firstRank: number;
      readonly lane: FairFrontierLane;
      readonly lastRank: number;
      readonly opportunityCount: number;
      readonly orderedCount: number;
    }>;

export type FairFrontierBundleOrderV1 = Readonly<{
  readonly coverage: Readonly<{
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly reasons: readonly [
      "candidate-pool-only",
      "lane-semantics-caller-declared",
      "not-budget-settled"
    ];
    readonly status: "partial";
  }>;
  readonly entries: readonly FairFrontierOrderedEntry[];
  readonly lanes: readonly FairFrontierLaneMetrics[];
  readonly orderId: string;
  readonly orderVersion: "muse.fair-frontier-bundle-order.v1";
  readonly requestId: string;
  readonly rotationOffset: number;
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly seed: Seed;
  readonly snapshot: Snapshot;
}>;

export type FairFrontierBundleOrderErrorCode =
  | "INVALID_REQUEST"
  | "INTERNAL_POSTCONDITION_FAILED";

export class FairFrontierBundleOrderError extends Error {
  readonly code: FairFrontierBundleOrderErrorCode;
  readonly details: Readonly<{ readonly path: string; readonly reason: string }>;

  constructor(
    code: FairFrontierBundleOrderErrorCode,
    reason: string,
    path: string
  ) {
    super("fair-frontier-bundle-order-failed");
    this.name = "FairFrontierBundleOrderError";
    this.code = code;
    this.details = Object.freeze({ path, reason });
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

const RAW = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_ID = /^muse-fair-frontier-request:sha256:[0-9a-f]{64}$/u;
const ORDER_ID = /^muse-fair-frontier-order:sha256:[0-9a-f]{64}$/u;
const BUNDLE_ID = /^muse-scoped-proof-document:sha256:[0-9a-f]{64}$/u;
const CANDIDATE_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const MAX_OPPORTUNITIES = 255;
const IS_PROXY = nodeTypes.isProxy;
const GET_OWN_DESCRIPTOR = Reflect.getOwnPropertyDescriptor;

function fail(reason: string, path: string): never {
  throw new FairFrontierBundleOrderError("INVALID_REQUEST", reason, path);
}

function internal(reason: string, path = ""): never {
  throw new FairFrontierBundleOrderError(
    "INTERNAL_POSTCONDITION_FAILED",
    reason,
    path
  );
}

function child(path: string, segment: string): string {
  const encoded = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return path === "" ? `/${encoded}` : `${path}/${encoded}`;
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
  const output = value as Record<string, unknown>;
  const keys = Object.keys(output);
  const permitted = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(output, key))
    || keys.some((key) => !permitted.has(key))
  ) {
    fail("invalid-field-set", path);
  }
  return output;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail("invalid-container", path);
  if (value.length > MAX_OPPORTUNITIES) fail("too-many-opportunities", path);
  return value;
}

function text(value: unknown, path: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || CONTROL.test(value)
  ) {
    fail("invalid-string", path);
  }
  return value;
}

function instant(value: unknown, path: string): string {
  const parsed = text(value, path, 64);
  const timestamp = Date.parse(parsed);
  if (
    !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString() !== parsed
  ) {
    fail("invalid-instant", path);
  }
  return parsed;
}

function scope(value: unknown, path: string): Scope {
  const root = record(value, ["sourceId", "threadId"], [], path);
  const sourceId = text(root.sourceId, child(path, "sourceId"), 128);
  if (!SOURCE_ID.test(sourceId)) fail("invalid-source-id", child(path, "sourceId"));
  return Object.freeze({
    sourceId,
    threadId: text(root.threadId, child(path, "threadId"), 256)
  });
}

function snapshot(value: unknown, path: string): Snapshot {
  try { return parseGraphSnapshotProvenance(value, path); }
  catch (cause) {
    if (cause instanceof GraphSnapshotProvenanceError) {
      const reason = cause.details.reason === "invalid-container"
        || cause.details.reason === "invalid-field-set"
        ? cause.details.reason
        : cause.details.reason === "invalid-safe-integer"
          ? "invalid-number"
          : cause.details.reason === "invalid-id"
            && cause.details.path.endsWith("/generationId")
            ? "invalid-generation-id"
            : cause.details.reason === "invalid-digest"
              && cause.details.path.endsWith("/commitHash")
              ? "invalid-commit-hash"
              : "invalid-snapshot-authority";
      fail(reason, cause.details.path);
    }
    throw cause;
  }
}

function seed(value: unknown, requestedScope: Scope, path: string): Seed {
  const root = record(value, ["kind", "id"], [], path);
  if (root.kind !== "thread") fail("invalid-seed-kind", child(path, "kind"));
  const id = text(root.id, child(path, "id"), 256);
  if (id !== requestedScope.threadId) fail("scope-seed-mismatch", child(path, "id"));
  return Object.freeze({ id, kind: "thread" as const });
}

function opportunity(value: unknown, path: string): Opportunity {
  const root = record(
    value,
    ["bundleId", "candidateId", "lane", "observedAt"],
    [],
    path
  );
  const bundleId = text(root.bundleId, child(path, "bundleId"), 99);
  if (!BUNDLE_ID.test(bundleId)) fail("invalid-bundle-id", child(path, "bundleId"));
  const candidateId = text(root.candidateId, child(path, "candidateId"), 96);
  if (
    Buffer.byteLength(candidateId, "ascii") !== candidateId.length
    || !CANDIDATE_ID.test(candidateId)
  ) {
    fail("invalid-candidate-id", child(path, "candidateId"));
  }
  if (
    typeof root.lane !== "string"
    || !(FAIR_FRONTIER_LANES as readonly string[]).includes(root.lane)
  ) {
    fail("invalid-lane", child(path, "lane"));
  }
  return Object.freeze({
    bundleId,
    candidateId,
    lane: root.lane as FairFrontierLane,
    observedAt: instant(root.observedAt, child(path, "observedAt"))
  });
}

function opportunityCompare(left: Opportunity, right: Opportunity): number {
  const time = Date.parse(right.observedAt) - Date.parse(left.observedAt);
  return time || RAW(left.bundleId, right.bundleId) || RAW(left.candidateId, right.candidateId);
}

function normalizedOpportunities(
  opportunities: readonly Opportunity[]
): readonly Opportunity[] {
  return Object.freeze(
    FAIR_FRONTIER_LANES.flatMap((lane) =>
      opportunities
        .filter((item) => item.lane === lane)
        .sort(opportunityCompare)
    )
  );
}

function mutableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function semanticRequestId(value: {
  readonly opportunities: readonly Opportunity[];
  readonly scope: Scope;
  readonly seed: Seed;
  readonly snapshot: Snapshot;
}): string {
  const body = {
    operatorVersion: "muse.fair-frontier-bundle-order.v1",
    opportunities: value.opportunities,
    schemaVersion: 1,
    scope: value.scope,
    seed: value.seed,
    snapshot: value.snapshot
  };
  return canonicalizeImmutableEnvelope(
    mutableJson(body),
    "external-mutable",
    REQUEST_SPEC
  ).contentId;
}

function rotationOffset(requestId: string, count: number): number {
  if (count === 0) return 0;
  const digest = requestId.slice(-64);
  return Number(BigInt(`0x${digest.slice(0, 16)}`) % BigInt(FAIR_FRONTIER_LANES.length));
}

function rotatedLanes(offset: number): readonly FairFrontierLane[] {
  return Object.freeze([
    ...FAIR_FRONTIER_LANES.slice(offset),
    ...FAIR_FRONTIER_LANES.slice(0, offset)
  ]);
}

function order(
  opportunities: readonly Opportunity[],
  offset: number
): readonly FairFrontierOrderedEntry[] {
  const queues = new Map< FairFrontierLane, Opportunity[]>(
    FAIR_FRONTIER_LANES.map((lane) => [
      lane,
      opportunities.filter((item) => item.lane === lane).sort(opportunityCompare)
    ])
  );
  const entries: FairFrontierOrderedEntry[] = [];
  while (entries.length < opportunities.length) {
    let emitted = false;
    for (const lane of rotatedLanes(offset)) {
      const next = queues.get(lane)?.shift();
      if (!next) continue;
      emitted = true;
      entries.push(Object.freeze({ ...next, rank: entries.length }));
    }
    if (!emitted) internal("order-progress-postcondition-failed");
  }
  return Object.freeze(entries);
}

function laneMetrics(
  entries: readonly FairFrontierOrderedEntry[],
  opportunities: readonly Opportunity[]
): readonly FairFrontierLaneMetrics[] {
  return Object.freeze(FAIR_FRONTIER_LANES.map((lane) => {
    const opportunityCount = opportunities.filter((item) => item.lane === lane).length;
    if (opportunityCount === 0) {
      return Object.freeze({ lane, opportunityCount: 0, orderedCount: 0 });
    }
    const ranks = entries.filter((item) => item.lane === lane).map((item) => item.rank);
    if (ranks.length !== opportunityCount || ranks[0] === undefined) {
      internal("lane-count-postcondition-failed");
    }
    return Object.freeze({
      firstRank: ranks[0],
      lane,
      lastRank: ranks[ranks.length - 1]!,
      opportunityCount,
      orderedCount: ranks.length
    });
  }));
}

function captureInput(input: unknown): Record<string, unknown> {
  try {
    if (
      input !== null
      && typeof input === "object"
      && !IS_PROXY(input)
      && GET_OWN_DESCRIPTOR(input, "admissionId") !== undefined
    ) {
      fail("invalid-field-set", "/admissionId");
    }
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

function captureOrder(body: Record<string, unknown>): FairFrontierBundleOrderV1 {
  try {
    const first = canonicalizeImmutableEnvelope(
      mutableJson(body),
      "external-mutable",
      ORDER_SPEC
    );
    const second = canonicalizeImmutableEnvelope(
      first.envelope,
      "muse-frozen",
      ORDER_SPEC
    );
    if (
      first.contentId !== second.contentId
      || first.canonicalJson !== second.canonicalJson
      || first.canonicalByteLength !== second.canonicalByteLength
      || !ORDER_ID.test(second.contentId)
    ) {
      internal("order-postcondition-failed");
    }
    return second.envelope as unknown as FairFrontierBundleOrderV1;
  } catch (cause) {
    if (cause instanceof FairFrontierBundleOrderError) throw cause;
    internal("order-postcondition-failed");
  }
}

export function orderFairFrontierBundles(
  input: unknown
): FairFrontierBundleOrderV1 {
  const captured = captureInput(input);
  const root = record(
    captured,
    [
      "schemaVersion",
      "operatorVersion",
      "admissionId",
      "scope",
      "snapshot",
      "seed",
      "opportunities"
    ],
    ["requestId"],
    ""
  );
  if (root.schemaVersion !== 1) fail("invalid-schema-version", "/schemaVersion");
  if (root.operatorVersion !== "muse.fair-frontier-bundle-order.v1") {
    fail("invalid-operator-version", "/operatorVersion");
  }
  const requestedScope = scope(root.scope, "/scope");
  const requestedSnapshot = snapshot(root.snapshot, "/snapshot");
  const requestedSeed = seed(root.seed, requestedScope, "/seed");
  const opportunities = array(root.opportunities, "/opportunities")
    .map((item, index) => opportunity(item, `/opportunities/${index.toString()}`));
  const candidateIds = opportunities.map((item) => item.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    fail("duplicate-candidate-id", "/opportunities");
  }
  const bundleIds = opportunities.map((item) => item.bundleId);
  if (new Set(bundleIds).size !== bundleIds.length) {
    fail("duplicate-bundle-id", "/opportunities");
  }
  const normalized = normalizedOpportunities(opportunities);
  const requestId = semanticRequestId({
    opportunities: normalized,
    scope: requestedScope,
    seed: requestedSeed,
    snapshot: requestedSnapshot
  });
  if (
    root.requestId !== undefined
    && (
      typeof root.requestId !== "string"
      || !REQUEST_ID.test(root.requestId)
      || root.requestId !== requestId
    )
  ) {
    fail("invalid-request-id", "/requestId");
  }
  const offset = rotationOffset(requestId, normalized.length);
  const entries = order(normalized, offset);
  const lanes = laneMetrics(entries, normalized);
  if (
    entries.length !== normalized.length
    || entries.some((item, index) => item.rank !== index)
    || lanes.reduce((sum, lane) => sum + lane.orderedCount, 0) !== entries.length
  ) {
    internal("order-conservation-postcondition-failed");
  }
  return captureOrder({
    coverage: {
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons: [
        "candidate-pool-only",
        "lane-semantics-caller-declared",
        "not-budget-settled"
      ],
      status: "partial"
    },
    entries,
    lanes,
    orderVersion: "muse.fair-frontier-bundle-order.v1",
    requestId,
    rotationOffset: offset,
    schemaVersion: 1,
    scope: requestedScope,
    seed: requestedSeed,
    snapshot: requestedSnapshot
  });
}
