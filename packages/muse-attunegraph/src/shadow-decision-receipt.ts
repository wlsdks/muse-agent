import { createHash } from "node:crypto";

import type {
  ContinuityPack,
  AttuneGraphShadowTimingProjectionV1
} from "@muse/attunement";
import {
  verifyAttuneGraphShadowTimingProjection
} from "@muse/attunement";
import {
  verifyScopedContinuitySourceObservation,
  type ContinuityScopedSourceObservationReceipt
} from "@muse/attunement/continuity-source-observations";
import {
  continuitySourceGraphPairMatches
} from "./continuity-source-graph-binding.js";
import {
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import type { ContinuityResumeRuntimeCoordinator } from "./continuity-resume-runtime.js";
import {
  getAttuneGraphShadowDecisionRuntimeEvidence,
  isAttuneGraphShadowDecisionCoordinator
} from "./shadow-decision-receipt-internal.js";

const VERSION = "muse.attunegraph.shadow-decision-receipt.v1" as const;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_CANONICAL_BYTES = 32 * 1024;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SOURCE_RECEIPT_ID_PATTERN =
  /^muse-continuity-scoped-source-observation:v1:sha256:[0-9a-f]{64}$/u;
const GRAPH_RECEIPT_ID_PATTERN =
  /^muse-continuity-observation:v1:sha256:[0-9a-f]{64}$/u;
const RECEIPT_ID_PATTERN = /^muse\.attunegraph\.shadow-decision:[a-f0-9]{64}$/u;

export type AttuneGraphShadowDecisionAuthorityV1 = Readonly<{
  readonly actionGranted: false;
  readonly capsuleReadiness: "unassessed";
  readonly decision: "deterministic-timing";
  readonly delivery: "not-performed";
  readonly feedback: "not-inferred";
  readonly graphBinding: "verified";
  readonly observations: "local-category-only";
}>;

export type AttuneGraphShadowDecisionReceiptV1 = Readonly<{
  readonly authority: AttuneGraphShadowDecisionAuthorityV1;
  readonly candidate: Readonly<{
    readonly counterfactual: Readonly<{ readonly action: string; readonly evaluatedAt: string }>;
    readonly createdAt: string;
    readonly decision: "silent" | "digest" | "offer";
    readonly id: string;
    readonly reason: string;
    readonly ruleVersion: 3;
    readonly sessionId: string;
  }>;
  readonly comparisonStatus: "no-change" | "complete" | "partial";
  readonly consentVersion: number;
  readonly evidenceObservationIds: readonly string[];
  readonly observationDigest: string;
  readonly policySnapshot: Readonly<{
    readonly offerCooldownMs: number;
    readonly stableFocusMs: number;
    readonly version: number;
  }>;
  readonly receiptId: string;
  readonly receiptVersion: typeof VERSION;
  readonly resumeResultDigest: string;
  readonly schemaVersion: 1;
  readonly scope: Readonly<{ readonly sourceId: string; readonly threadId: string }>;
  readonly sourceGraphReceipts: Readonly<{
    readonly currentGraphReceiptId: string;
    readonly currentSourceReceiptId: string;
    readonly previousGraphReceiptId: string;
    readonly previousSourceReceiptId: string;
  }>;
  readonly witnessStatus: "partial" | "abstained" | "capacity-invalid";
}>;

export type AttuneGraphShadowDecisionCaptureV1 =
  | Readonly<{
      readonly dependencies: AttuneGraphShadowDecisionVerificationDependenciesV1;
      readonly receipt: AttuneGraphShadowDecisionReceiptV1;
      readonly status: "captured";
    }>
  | Readonly<{
      readonly reason:
        | "not-exact-compared-result"
        | "coordinator-mismatch"
        | "missing-pack-sidecar"
        | "pack-mismatch"
        | "invalid-timing-projection"
        | "evidence-mismatch"
        | "graph-observed-after-decision"
        | "budget-exceeded";
      readonly status: "abstained";
    }>;

export type AttuneGraphShadowDecisionVerificationDependenciesV1 = Readonly<{
  readonly coordinator: ContinuityResumeRuntimeCoordinator;
  readonly currentGraphObservationReceipt: ContinuityObservationReceipt;
  readonly currentSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly exactComparedResult: unknown;
  readonly exactPack: ContinuityPack;
  readonly previousGraphObservationReceipt: ContinuityObservationReceipt;
  readonly previousSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly timingProjection: AttuneGraphShadowTimingProjectionV1;
}>;

function abstained(
  reason: Extract<AttuneGraphShadowDecisionCaptureV1, { readonly status: "abstained" }> ["reason"]
): AttuneGraphShadowDecisionCaptureV1 {
  return Object.freeze({ reason, status: "abstained" as const });
}

function canonicalInstant(value: unknown): value is string {
  return typeof value === "string"
    && CANONICAL_INSTANT_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestObject(value: object): string {
  return sha256(JSON.stringify(value));
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ("value" in descriptor) freeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function validProjection(
  projection: unknown
): projection is AttuneGraphShadowTimingProjectionV1 {
  if (typeof projection !== "object" || projection === null) return false;
  const value = projection as AttuneGraphShadowTimingProjectionV1;
  const candidate = value.candidate;
  if (
    value.schemaVersion !== 1
    || value.projectionVersion !== "muse.attunegraph.shadow-timing-projection.v1"
    || !Number.isSafeInteger(value.sessionConsentVersion)
    || value.sessionConsentVersion < 1
    || candidate.ruleVersion !== 3
    || !canonicalInstant(candidate.createdAt)
    || candidate.counterfactual.evaluatedAt !== candidate.createdAt
    || candidate.evidenceObservationIds.length > 2
    || value.observations.length !== candidate.evidenceObservationIds.length
    || !SHA_256_PATTERN.test(value.observationDigest)
  ) return false;
  const observationIds = value.observations.map((observation) => observation.id);
  return observationIds.every((id, index) =>
    id === candidate.evidenceObservationIds[index]
    && value.observations[index]?.sessionId === candidate.sessionId
    && value.observations[index]?.threadId === candidate.threadId
  )
    && new Set(observationIds).size === observationIds.length
    && candidate.policySnapshot.offerCooldownMs > 0
    && candidate.policySnapshot.stableFocusMs > 0
    && Number.isSafeInteger(candidate.policySnapshot.version)
    && candidate.policySnapshot.version >= 0;
}

function privateEvidenceMatches(
  evidence: NonNullable<ReturnType<typeof getAttuneGraphShadowDecisionRuntimeEvidence>>,
  projection: AttuneGraphShadowTimingProjectionV1
): boolean {
  const previousSource = verifyScopedContinuitySourceObservation(
    evidence.previousSourceObservationReceipt
  );
  const currentSource = verifyScopedContinuitySourceObservation(
    evidence.currentSourceObservationReceipt
  );
  const previousGraph = verifyContinuityObservation(
    evidence.previousGraphObservationReceipt
  );
  const currentGraph = verifyContinuityObservation(
    evidence.currentGraphObservationReceipt
  );
  const scope = evidence.currentSourceObservationReceipt.scope;
  return continuitySourceGraphPairMatches(previousSource, previousGraph)
    && continuitySourceGraphPairMatches(currentSource, currentGraph)
    && scope.sourceId === evidence.previousSourceObservationReceipt.scope.sourceId
    && scope.threadId === evidence.previousSourceObservationReceipt.scope.threadId
    && scope.threadId === projection.candidate.threadId
    && evidence.currentGraphObservationReceipt.projection.scope.sourceId === scope.sourceId
    && evidence.currentGraphObservationReceipt.projection.scope.threadId === scope.threadId
    && evidence.previousGraphObservationReceipt.projection.scope.sourceId === scope.sourceId
    && evidence.previousGraphObservationReceipt.projection.scope.threadId === scope.threadId
    && canonicalInstant(evidence.currentGraphObservationReceipt.observedAt)
    && canonicalInstant(evidence.previousGraphObservationReceipt.observedAt)
    && canonicalInstant(evidence.currentSourceObservationReceipt.observation.observedAt)
    && canonicalInstant(evidence.previousSourceObservationReceipt.observation.observedAt);
}

function resumeResultDigest(
  result: Readonly<Record<string, unknown>>
): string | undefined {
  const { comparisonStatus, schemaVersion, state, status, witnessStatus } = result;
  if (
    schemaVersion !== 1
    || status !== "partial"
    || (state !== "compared-and-advanced" && state !== "compared-with-baseline-reused")
    || (comparisonStatus !== "no-change" && comparisonStatus !== "complete" && comparisonStatus !== "partial")
    || (witnessStatus !== "partial" && witnessStatus !== "abstained" && witnessStatus !== "capacity-invalid")
  ) return undefined;
  return sha256(JSON.stringify(result));
}

export function captureAttuneGraphShadowDecisionReceipt(
  coordinator: unknown,
  exactComparedResult: unknown,
  exactPack: unknown,
  timingProjection: unknown
): AttuneGraphShadowDecisionCaptureV1 {
  if (typeof exactComparedResult !== "object" || exactComparedResult === null) {
    return abstained("not-exact-compared-result");
  }
  const evidence = getAttuneGraphShadowDecisionRuntimeEvidence(exactComparedResult);
  if (evidence === undefined) return abstained("not-exact-compared-result");
  if (!isAttuneGraphShadowDecisionCoordinator(coordinator, evidence.coordinator)) {
    return abstained("coordinator-mismatch");
  }
  if (evidence.pack === undefined) return abstained("missing-pack-sidecar");
  if (exactPack !== evidence.pack || digestObject(evidence.pack) !== evidence.packDigest) {
    return abstained("pack-mismatch");
  }
  const projection = verifyAttuneGraphShadowTimingProjection(timingProjection);
  if (projection === undefined || !validProjection(projection)) {
    return abstained("invalid-timing-projection");
  }
  if (!privateEvidenceMatches(evidence, projection)) return abstained("evidence-mismatch");
  if (Date.parse(evidence.currentGraphObservationReceipt.observedAt) > Date.parse(projection.candidate.createdAt)) {
    return abstained("graph-observed-after-decision");
  }
  const digest = resumeResultDigest(exactComparedResult as Readonly<Record<string, unknown>>);
  if (digest === undefined || digest !== evidence.resumeResultDigest) {
    return abstained("not-exact-compared-result");
  }
  const body = {
    authority: {
      actionGranted: false as const,
      capsuleReadiness: "unassessed" as const,
      decision: "deterministic-timing" as const,
      delivery: "not-performed" as const,
      feedback: "not-inferred" as const,
      graphBinding: "verified" as const,
      observations: "local-category-only" as const
    },
    candidate: {
      counterfactual: projection.candidate.counterfactual,
      createdAt: projection.candidate.createdAt,
      decision: projection.candidate.decision,
      id: projection.candidate.id,
      reason: projection.candidate.reason,
      ruleVersion: 3 as const,
      sessionId: projection.candidate.sessionId
    },
    comparisonStatus: (exactComparedResult as { comparisonStatus: AttuneGraphShadowDecisionReceiptV1["comparisonStatus"] }).comparisonStatus,
    consentVersion: projection.sessionConsentVersion,
    evidenceObservationIds: [...projection.candidate.evidenceObservationIds],
    observationDigest: projection.observationDigest,
    policySnapshot: projection.candidate.policySnapshot,
    receiptVersion: VERSION,
    resumeResultDigest: digest,
    schemaVersion: 1 as const,
    scope: evidence.currentSourceObservationReceipt.scope,
    sourceGraphReceipts: {
      currentGraphReceiptId: evidence.currentGraphObservationReceipt.receiptId,
      currentSourceReceiptId: evidence.currentSourceObservationReceipt.receiptId,
      previousGraphReceiptId: evidence.previousGraphObservationReceipt.receiptId,
      previousSourceReceiptId: evidence.previousSourceObservationReceipt.receiptId
    },
    witnessStatus: (exactComparedResult as { witnessStatus: AttuneGraphShadowDecisionReceiptV1["witnessStatus"] }).witnessStatus
  };
  const canonical = JSON.stringify(body);
  if (Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES) return abstained("budget-exceeded");
  const receipt = freeze({
    ...body,
    receiptId: `muse.attunegraph.shadow-decision:${sha256(`${VERSION}\n${canonical}`)}`
  }) as AttuneGraphShadowDecisionReceiptV1;
  return Object.freeze({
    dependencies: Object.freeze({
      coordinator: coordinator as ContinuityResumeRuntimeCoordinator,
      currentGraphObservationReceipt: evidence.currentGraphObservationReceipt,
      currentSourceObservationReceipt: evidence.currentSourceObservationReceipt,
      exactComparedResult,
      exactPack: evidence.pack,
      previousGraphObservationReceipt: evidence.previousGraphObservationReceipt,
      previousSourceObservationReceipt: evidence.previousSourceObservationReceipt,
      timingProjection: projection
    }),
    receipt,
    status: "captured" as const
  });
}

export function serializeAttuneGraphShadowDecisionReceipt(
  receipt: AttuneGraphShadowDecisionReceiptV1
): string {
  return JSON.stringify(receiptBody(receipt));
}

function receiptBody(receipt: AttuneGraphShadowDecisionReceiptV1) {
  return {
    authority: receipt.authority,
    candidate: receipt.candidate,
    comparisonStatus: receipt.comparisonStatus,
    consentVersion: receipt.consentVersion,
    evidenceObservationIds: receipt.evidenceObservationIds,
    observationDigest: receipt.observationDigest,
    policySnapshot: receipt.policySnapshot,
    receiptVersion: receipt.receiptVersion,
    resumeResultDigest: receipt.resumeResultDigest,
    schemaVersion: receipt.schemaVersion,
    scope: receipt.scope,
    sourceGraphReceipts: receipt.sourceGraphReceipts,
    witnessStatus: receipt.witnessStatus
  };
}

/**
 * Validates canonical bytes only when every authoritative dependency is
 * present. A stored receipt alone intentionally cannot claim graph binding.
 */
export function verifyAttuneGraphShadowDecisionReceipt(
  value: unknown,
  dependencies?: AttuneGraphShadowDecisionVerificationDependenciesV1
): AttuneGraphShadowDecisionReceiptV1 | undefined {
  const root = exactRecord(value, [
    "authority", "candidate", "comparisonStatus", "consentVersion",
    "evidenceObservationIds", "observationDigest", "policySnapshot",
    "receiptId", "receiptVersion", "resumeResultDigest", "schemaVersion",
    "scope", "sourceGraphReceipts", "witnessStatus"
  ]);
  if (root === undefined) return undefined;
  const authority = exactRecord(root.authority, [
    "actionGranted", "capsuleReadiness", "decision", "delivery", "feedback",
    "graphBinding", "observations"
  ]);
  const candidate = exactRecord(root.candidate, [
    "counterfactual", "createdAt", "decision", "id", "reason", "ruleVersion", "sessionId"
  ]);
  const counterfactual = candidate === undefined ? undefined : exactRecord(
    candidate.counterfactual,
    ["action", "evaluatedAt"]
  );
  const policySnapshot = exactRecord(root.policySnapshot, [
    "offerCooldownMs", "stableFocusMs", "version"
  ]);
  const scope = exactRecord(root.scope, ["sourceId", "threadId"]);
  const sourceGraphReceipts = exactRecord(root.sourceGraphReceipts, [
    "currentGraphReceiptId", "currentSourceReceiptId", "previousGraphReceiptId", "previousSourceReceiptId"
  ]);
  const evidenceObservationIds = exactStringArray(root.evidenceObservationIds, 2);
  if (
    authority === undefined
    || candidate === undefined
    || counterfactual === undefined
    || policySnapshot === undefined
    || scope === undefined
    || sourceGraphReceipts === undefined
    || evidenceObservationIds === undefined
    || authority.actionGranted !== false
    || authority.capsuleReadiness !== "unassessed"
    || authority.decision !== "deterministic-timing"
    || authority.delivery !== "not-performed"
    || authority.feedback !== "not-inferred"
    || authority.graphBinding !== "verified"
    || authority.observations !== "local-category-only"
    || candidate.ruleVersion !== 3
    || !oneOf(candidate.decision, ["silent", "digest", "offer"])
    || !oneOf(candidate.reason, [
      "session-paused", "no-observation", "focus-block-too-short",
      "no-category-boundary", "offer-cooldown-active", "stable-focus-category-boundary"
    ])
    || !oneOf(counterfactual.action, ["stay-silent", "queue-digest", "present-offer"])
    || !counterfactualMatchesDecision(candidate.decision, counterfactual.action)
    || !isBoundedText(candidate.id, 1_024)
    || !isBoundedText(candidate.sessionId, 1_024)
    || !canonicalInstant(candidate.createdAt)
    || counterfactual.evaluatedAt !== candidate.createdAt
    || !canonicalInstant(counterfactual.evaluatedAt)
    || !oneOf(root.comparisonStatus, ["no-change", "complete", "partial"])
    || !oneOf(root.witnessStatus, ["partial", "abstained", "capacity-invalid"])
    || !isPositiveSafeInteger(root.consentVersion)
    || !SHA_256_PATTERN.test(stringOrEmpty(root.observationDigest))
    || !SHA_256_PATTERN.test(stringOrEmpty(root.resumeResultDigest))
    || !isPositiveSafeInteger(policySnapshot.offerCooldownMs)
    || !isPositiveSafeInteger(policySnapshot.stableFocusMs)
    || !isNonNegativeSafeInteger(policySnapshot.version)
    || !SOURCE_ID_PATTERN.test(stringOrEmpty(scope.sourceId))
    || !isBoundedText(scope.threadId, 1_024)
    || !SOURCE_RECEIPT_ID_PATTERN.test(stringOrEmpty(sourceGraphReceipts.currentSourceReceiptId))
    || !SOURCE_RECEIPT_ID_PATTERN.test(stringOrEmpty(sourceGraphReceipts.previousSourceReceiptId))
    || !GRAPH_RECEIPT_ID_PATTERN.test(stringOrEmpty(sourceGraphReceipts.currentGraphReceiptId))
    || !GRAPH_RECEIPT_ID_PATTERN.test(stringOrEmpty(sourceGraphReceipts.previousGraphReceiptId))
    || root.schemaVersion !== 1
    || root.receiptVersion !== VERSION
    || !RECEIPT_ID_PATTERN.test(stringOrEmpty(root.receiptId))
  ) return undefined;
  const body = {
    authority: {
      actionGranted: false as const,
      capsuleReadiness: "unassessed" as const,
      decision: "deterministic-timing" as const,
      delivery: "not-performed" as const,
      feedback: "not-inferred" as const,
      graphBinding: "verified" as const,
      observations: "local-category-only" as const
    },
    candidate: {
      counterfactual: { action: counterfactual.action, evaluatedAt: counterfactual.evaluatedAt },
      createdAt: candidate.createdAt,
      decision: candidate.decision,
      id: candidate.id,
      reason: candidate.reason,
      ruleVersion: 3 as const,
      sessionId: candidate.sessionId
    },
    comparisonStatus: root.comparisonStatus,
    consentVersion: root.consentVersion,
    evidenceObservationIds,
    observationDigest: root.observationDigest,
    policySnapshot: {
      offerCooldownMs: policySnapshot.offerCooldownMs,
      stableFocusMs: policySnapshot.stableFocusMs,
      version: policySnapshot.version
    },
    receiptVersion: VERSION,
    resumeResultDigest: root.resumeResultDigest,
    schemaVersion: 1 as const,
    scope: { sourceId: scope.sourceId, threadId: scope.threadId },
    sourceGraphReceipts: {
      currentGraphReceiptId: sourceGraphReceipts.currentGraphReceiptId,
      currentSourceReceiptId: sourceGraphReceipts.currentSourceReceiptId,
      previousGraphReceiptId: sourceGraphReceipts.previousGraphReceiptId,
      previousSourceReceiptId: sourceGraphReceipts.previousSourceReceiptId
    },
    witnessStatus: root.witnessStatus
  };
  const canonical = JSON.stringify(body);
  if (
    Buffer.byteLength(canonical, "utf8") > MAX_CANONICAL_BYTES
    || root.receiptId !== `muse.attunegraph.shadow-decision:${sha256(`${VERSION}\n${canonical}`)}`
  ) return undefined;
  if (dependencies === undefined) {
    return undefined;
  }
  const recomputed = captureAttuneGraphShadowDecisionReceipt(
    dependencies.coordinator,
    dependencies.exactComparedResult,
    dependencies.exactPack,
    dependencies.timingProjection
  );
  if (
    recomputed.status !== "captured"
    || !validVerificationDependencies(
      dependencies,
      body as ReturnType<typeof receiptBody>
    )
    || serializeAttuneGraphShadowDecisionReceipt(recomputed.receipt) !== canonical
  ) {
    return undefined;
  }
  return freeze({ ...body, receiptId: root.receiptId }) as AttuneGraphShadowDecisionReceiptV1;
}

function validVerificationDependencies(
  dependencies: AttuneGraphShadowDecisionVerificationDependenciesV1,
  body: ReturnType<typeof receiptBody>
): boolean {
  try {
    const previousSource = verifyScopedContinuitySourceObservation(
      dependencies.previousSourceObservationReceipt
    );
    const currentSource = verifyScopedContinuitySourceObservation(
      dependencies.currentSourceObservationReceipt
    );
    const previousGraph = verifyContinuityObservation(
      dependencies.previousGraphObservationReceipt
    );
    const currentGraph = verifyContinuityObservation(
      dependencies.currentGraphObservationReceipt
    );
    const projection = verifyAttuneGraphShadowTimingProjection(
      dependencies.timingProjection
    );
    return previousSource.receiptId === body.sourceGraphReceipts.previousSourceReceiptId
      && currentSource.receiptId === body.sourceGraphReceipts.currentSourceReceiptId
      && previousGraph.receiptId === body.sourceGraphReceipts.previousGraphReceiptId
      && currentGraph.receiptId === body.sourceGraphReceipts.currentGraphReceiptId
      && continuitySourceGraphPairMatches(previousSource, previousGraph)
      && continuitySourceGraphPairMatches(currentSource, currentGraph)
      && previousSource.scope.sourceId === body.scope.sourceId
      && previousSource.scope.threadId === body.scope.threadId
      && currentSource.scope.sourceId === body.scope.sourceId
      && currentSource.scope.threadId === body.scope.threadId
      && projection !== undefined
      && projection.candidate.id === body.candidate.id
      && projection.candidate.sessionId === body.candidate.sessionId
      && projection.candidate.createdAt === body.candidate.createdAt
      && projection.sessionConsentVersion === body.consentVersion
      && projection.observationDigest === body.observationDigest
      && JSON.stringify(projection.candidate.policySnapshot) === JSON.stringify(body.policySnapshot)
      && JSON.stringify(projection.candidate.evidenceObservationIds)
        === JSON.stringify(body.evidenceObservationIds);
  } catch {
    return false;
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== keys.length
      || keys.some((key) => !Object.hasOwn(descriptors, key))
    ) return undefined;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch {
    return undefined;
  }
}

function exactStringArray(value: unknown, maximum: number): readonly string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== value.length + 1) return undefined;
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !isBoundedText(descriptor.value, 1_024)) return undefined;
      items.push(descriptor.value);
    }
    return new Set(items).size === items.length ? Object.freeze(items) : undefined;
  } catch {
    return undefined;
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function counterfactualMatchesDecision(decision: unknown, action: unknown): boolean {
  return (decision === "silent" && action === "stay-silent")
    || (decision === "digest" && action === "queue-digest")
    || (decision === "offer" && action === "present-offer");
}
