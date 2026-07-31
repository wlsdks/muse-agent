import { createHash } from "node:crypto";

import {
  ARTIFACT_ROLES,
  ARTIFACT_TYPES,
  isCoherentArtifactProvider,
  prepareContinuityPack,
  type ArtifactType,
  type ContinuityPack,
  type ExactArtifactResolver
} from "@muse/attunement";
import {
  captureScopedContinuitySourceObservation,
  verifyScopedContinuitySourceObservation,
  type ContinuityScopedSourceObservationReceipt,
  type ContinuityScopedSourceObservationScope
} from "@muse/attunement/continuity-source-observations";
import {
  verifyMintedLocalAttunementSnapshotHeadRevalidation,
  type LocalAttunementSnapshotHeadRevalidation
} from "@muse/attunement/continuity-snapshots";
import {
  parseAttunementState
} from "@muse/attunement/state-validation";

import {
  compileContinuityResumeContext,
  getContinuityResumeContextAudit,
  type ContinuityResumeAgentContextV1
} from "./continuity-resume-context-orchestrator.js";
import {
  captureContinuityResumeBoundary,
  verifyContinuityResumeBoundaryWithDependencies,
  type ContinuityResumeBoundary
} from "./continuity-resume-boundary.js";
import {
  verifyContinuityObservation,
  type ContinuityObservationReceipt
} from "./continuity-observation.js";
import {
  continuitySourceGraphPairMatches
} from "./continuity-source-graph-binding.js";
import {
  compileHeadRevalidatedProviderBoundGraphEvidence,
  isProcessMintedProviderHeadRevalidatedGraphEvidence,
  type ProviderHeadRevalidatedGraphEvidenceV1
} from "./provider-head-revalidated-graph-evidence.js";
import {
  presentContinuityCapsule,
  type ContinuityCapsulePresentation
} from "./continuity-capsule-presentation.js";
import {
  prepareEvidenceBoundContinuityCapsule,
  type ContinuityCapsuleModelPreparationResultV1,
  type EvidenceBoundContinuityCapsuleManifestV3,
  type EvidenceBoundContinuityCapsulePresentationV2,
  type ContinuityCapsulePreparationReceiptV1,
  type ContinuityCapsuleEvidenceInputV1
} from "./continuity-capsule-model-preparation.js";
import { CONTINUITY_CAPSULE_MANIFEST_LIMITS } from "./continuity-capsule-manifest.js";
import type { ModelProvider } from "@muse/model";
import {
  bindAttuneGraphShadowDecisionCoordinator,
  bindAttuneGraphShadowDecisionRuntimeEvidence
} from "./shadow-decision-receipt-internal.js";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PREPARED_TITLE_CONTROL = /[\u0000-\u001F\u007F]/u;
const PREPARED_CONTENT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const CAPSULE_PREPARATION_SUPPORTED_SOURCE_CLASSES =
  new Set<ArtifactType>(["task", "note", "reminder"]);

export const CONTINUITY_RESUME_RUNTIME_LIMITS = Object.freeze({
  maxBaselines: 16,
  maxCaptureSpanMs: 1_000,
  maxInFlight: 4,
  operationTimeoutMs: 5_000
});

const RESUME_BUDGET = Object.freeze({
  maxAssertions: 32,
  maxConsideredAssertions: 256,
  maxDepth: 4,
  maxEstimatedTokens: 4_096,
  maxOutputBytes: 262_144,
  maxVisitedRefs: 128
});

const AUTHORITY = Object.freeze({
  canAssertCurrentWorldTruth: false as const,
  canAssertSourceCompleteness: false as const,
  canGrantActionAuthority: false as const
});

export type ContinuityResumeRuntimeCaptureV1 = Readonly<{
  readonly currentSourceObservationReceipt?:
    ContinuityScopedSourceObservationReceipt;
  readonly currentProviderResult: ProviderHeadRevalidatedGraphEvidenceV1;
}>;

export interface ContinuityResumeRuntimeCaptureAdapterDependencies {
  readonly captureHeadRevalidation: (
    scope: Readonly<ContinuityScopedSourceObservationScope>,
    options: Readonly<{ readonly maxCaptureSpanMs: number }>
  ) => Promise<LocalAttunementSnapshotHeadRevalidation>;
  readonly resolveExactArtifact: ExactArtifactResolver;
}

export type ContinuityResumeRuntimeUnavailableReason =
  | "invalid-scope"
  | "runtime-busy"
  | "runtime-capacity"
  | "operation-timeout"
  | "capture-span-exceeded"
  | "capture-failed"
  | "provider-not-partial"
  | "current-evidence-invalid"
  | "graph-projection-failed"
  | "observation-regressed"
  | "observation-conflict"
  | "baseline-store-unavailable"
  | "resume-context-unavailable"
  | "runtime-generation-changed";

type RuntimeAuthority = typeof AUTHORITY;

export type ContinuityResumeRuntimeMutationReceiptV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly summary: "none" | "committed" | "possible";
  readonly effects: readonly Readonly<{
    readonly target: "baseline" | "projection";
    readonly durability: "process-local" | "durable-local";
    readonly outcome:
      | "committed"
      | "unchanged"
      | "conflict"
      | "not-attempted"
      | "outcome-unknown";
  }>[];
}>;

export type ContinuityResumeRuntimeUnavailableV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly status: "unavailable";
  readonly reason: ContinuityResumeRuntimeUnavailableReason;
  readonly authority: RuntimeAuthority;
}>;

export type ContinuityResumeRuntimeSeededV1 =
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "partial";
      readonly state: "process-local-baseline-seeded";
      readonly reason: "no-prior-process-local-baseline";
      readonly authority: RuntimeAuthority;
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "partial";
      readonly state: "durable-baseline-seeded";
      readonly reason: "no-prior-durable-baseline";
      readonly authority: RuntimeAuthority;
    }>;

export type ContinuityResumeRuntimeComparedV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly status: "partial";
  readonly state:
    | "compared-and-advanced"
    | "compared-with-baseline-reused";
  readonly comparisonStatus: "no-change" | "complete" | "partial";
  readonly witnessStatus: "partial" | "abstained" | "capacity-invalid";
  readonly resumeContextFacts:
    ContinuityResumeAgentContextV1["resumeContextFacts"];
  readonly supportingFacts:
    ContinuityResumeAgentContextV1["supportingFacts"];
  readonly authority: RuntimeAuthority;
}>;

export type ContinuityResumeRuntimeResultV1 =
  | ContinuityResumeRuntimeUnavailableV1
  | ContinuityResumeRuntimeSeededV1
  | ContinuityResumeRuntimeComparedV1;

export interface ContinuityResumeRuntimeCoordinator {
  preview(
    scope: ContinuityScopedSourceObservationScope
  ): Promise<ContinuityResumeRuntimeResultV1>;
}

export type ContinuityResumeRuntimeCapsulePreparationResultV1 =
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "ready";
      readonly evidenceInput: ContinuityCapsuleEvidenceInputV1;
      readonly receipt: ContinuityCapsulePreparationReceiptV1;
      readonly manifest: EvidenceBoundContinuityCapsuleManifestV3;
      readonly presentation: EvidenceBoundContinuityCapsulePresentationV2;
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "unavailable";
      readonly reason: "unsupported-source-class";
      readonly unsupportedSourceClasses: readonly ArtifactType[];
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "unavailable";
      readonly reason:
        | "invalid-exact-result"
        | Extract<
            ContinuityCapsuleModelPreparationResultV1,
            { readonly status: "unavailable" }
          >["reason"];
    }>;

export interface ContinuityResumeRuntimeCapsulePreparationOptions {
  /**
   * The caller-requested Source scope. The private previous/current receipt
   * sidecars must both match it before any provider call is admitted.
   */
  readonly expectedScope: ContinuityScopedSourceObservationScope;
  readonly locale: "en" | "ko";
  readonly modelProvider: Pick<ModelProvider, "id" | "generate">;
  readonly model: string;
  readonly signal?: AbortSignal;
  /** @internal deterministic-test seam */
  readonly now?: () => Date;
  /** @internal deterministic-test seam */
  readonly timeoutMs?: number;
}

/**
 * Caller-declared preparation for an explicit, display-only Capsule preview.
 * This intentionally excludes all receipt and graph fields: those are held in
 * a private identity sidecar after the runtime has compared them.
 */
export type ContinuityResumeRuntimeCapsuleRequestV1 = Readonly<{
  readonly locale: "en" | "ko";
  readonly preparedWork: Readonly<{
    readonly kind: "draft" | "action-preview";
    readonly title: string;
    readonly content: string;
    readonly expectedMinutes: number;
  }>;
  readonly supportingEvidenceRefs?: readonly Readonly<{
    readonly artifactId: string;
    readonly artifactType: string;
    readonly providerId: string;
    readonly role: string;
  }>[];
}>;

export interface ContinuityResumeRuntimeCoordinatorDependencies {
  readonly captureCurrent: (
    scope: Readonly<ContinuityScopedSourceObservationScope>
  ) => Promise<ContinuityResumeRuntimeCaptureV1>;
  /**
   * Optional application-owned durable projection. The coordinator invokes it
   * only after current Provider/Source/Graph cross-links are verified and
   * before advancing its process-local baseline.
   */
  readonly projectCurrentGraphObservation?: (
    observation: ContinuityObservationReceipt
  ) => Promise<Readonly<{ readonly status: "projected" | "replayed" }>>;
  readonly baselineStore?: ContinuityResumeRuntimeBaselineStore;
  /** @internal deterministic-test seam */
  readonly monotonicNowMs?: () => number;
}

export const CONTINUITY_RESUME_RUNTIME_BASELINE_VERSION =
  "muse.continuity-resume-baseline.v1" as const;

export type ContinuityResumeRuntimeBaselineV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly baselineVersion:
    typeof CONTINUITY_RESUME_RUNTIME_BASELINE_VERSION;
  readonly scope: Readonly<ContinuityScopedSourceObservationScope>;
  readonly boundary: ContinuityResumeBoundary;
  readonly sourceObservationReceipt:
    ContinuityScopedSourceObservationReceipt;
  readonly graphObservationReceipt: ContinuityObservationReceipt;
}>;

export interface ContinuityResumeRuntimeBaselineStore {
  load(
    scope: Readonly<ContinuityScopedSourceObservationScope>
  ): Promise<unknown | undefined>;
  compareAndSet(
    scope: Readonly<ContinuityScopedSourceObservationScope>,
    expectedBoundaryId: string | undefined,
    proposed: ContinuityResumeRuntimeBaselineV1
  ): Promise<"stored" | "unchanged" | "conflict">;
}

type Baseline = ContinuityResumeRuntimeBaselineV1;

type BusyToken = { active: boolean };

type ContinuityResumeRuntimeCapsuleEvidence = Readonly<{
  readonly previousSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly previousGraphObservationReceipt: ContinuityObservationReceipt;
  readonly currentSourceObservationReceipt: ContinuityScopedSourceObservationReceipt;
  readonly currentGraphObservationReceipt: ContinuityObservationReceipt;
}>;

const CONTINUITY_RESUME_RUNTIME_CAPTURE_PACKS =
  new WeakMap<object, ContinuityPack>();
const CONTINUITY_RESUME_RUNTIME_RESULT_PACKS =
  new WeakMap<object, ContinuityPack>();
const CONTINUITY_RESUME_RUNTIME_RESULT_CAPSULE_EVIDENCE =
  new WeakMap<object, ContinuityResumeRuntimeCapsuleEvidence>();
const CONTINUITY_RESUME_RUNTIME_RESULT_MUTATION_RECEIPTS =
  new WeakMap<object, ContinuityResumeRuntimeMutationReceiptV1>();

function frozenRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const descriptor of Object.values(
    Object.getOwnPropertyDescriptors(value)
  )) {
    if ("value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function unavailable(
  reason: ContinuityResumeRuntimeUnavailableReason
): ContinuityResumeRuntimeUnavailableV1 {
  return frozenRecord({
    schemaVersion: 1 as const,
    status: "unavailable" as const,
    reason,
    authority: AUTHORITY
  }) as ContinuityResumeRuntimeUnavailableV1;
}

function mutationReceipt(
  projection: ContinuityResumeRuntimeMutationReceiptV1["effects"][number]["outcome"],
  baseline: ContinuityResumeRuntimeMutationReceiptV1["effects"][number]["outcome"],
  baselineDurability: "process-local" | "durable-local"
): ContinuityResumeRuntimeMutationReceiptV1 {
  const effects = Object.freeze([
    frozenRecord({
      target: "projection" as const,
      durability: "durable-local" as const,
      outcome: projection
    }),
    frozenRecord({
      target: "baseline" as const,
      durability: baselineDurability,
      outcome: baseline
    })
  ]);
  const summary = projection === "outcome-unknown"
    || baseline === "outcome-unknown"
    ? "possible" as const
    : projection === "committed" || baseline === "committed"
      ? "committed" as const
      : "none" as const;
  return frozenRecord({
    schemaVersion: 1 as const,
    summary,
    effects
  }) as ContinuityResumeRuntimeMutationReceiptV1;
}

function bindResultMutationReceipt<T extends ContinuityResumeRuntimeResultV1>(
  result: T,
  receipt: ContinuityResumeRuntimeMutationReceiptV1
): T {
  CONTINUITY_RESUME_RUNTIME_RESULT_MUTATION_RECEIPTS.set(result, receipt);
  return result;
}

export function getContinuityResumeRuntimeMutationReceipt(
  result: unknown
): ContinuityResumeRuntimeMutationReceiptV1 | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return CONTINUITY_RESUME_RUNTIME_RESULT_MUTATION_RECEIPTS.get(result);
}

function bindResultPack<T extends ContinuityResumeRuntimeResultV1>(
  result: T,
  capture: ContinuityResumeRuntimeCaptureV1
): T {
  const pack = CONTINUITY_RESUME_RUNTIME_CAPTURE_PACKS.get(capture);
  if (pack !== undefined) {
    CONTINUITY_RESUME_RUNTIME_RESULT_PACKS.set(result, pack);
  }
  return result;
}

function digestRuntimeEvidence(value: object): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function getContinuityResumeRuntimePack(
  result: unknown
): ContinuityPack | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  return CONTINUITY_RESUME_RUNTIME_RESULT_PACKS.get(result);
}

function ownDataRecord(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors: Record<PropertyKey, PropertyDescriptor | undefined> =
      Object.getOwnPropertyDescriptors(value) as unknown as Record<
        PropertyKey,
        PropertyDescriptor | undefined
      >;
    if (
      Reflect.ownKeys(descriptors).length !== keys.length
      || keys.some((key) => !(key in descriptors))
    ) {
      return undefined;
    }
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

function ownDataArray(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const descriptors: Record<PropertyKey, PropertyDescriptor | undefined> =
      Object.getOwnPropertyDescriptors(value) as unknown as Record<
        PropertyKey,
        PropertyDescriptor | undefined
      >;
    const length = descriptors["length"];
    if (length === undefined || !("value" in length) || typeof length.value !== "number") {
      return undefined;
    }
    const items: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor)) return undefined;
      items.push(descriptor.value);
    }
    if (Reflect.ownKeys(descriptors).length !== length.value + 1) return undefined;
    return Object.freeze(items);
  } catch {
    return undefined;
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateContinuityResumeRuntimeCapsuleRequest(
  value: unknown
): ContinuityResumeRuntimeCapsuleRequestV1 | undefined {
  const record = ownDataRecord(value, ["locale", "preparedWork", "supportingEvidenceRefs"])
    ?? ownDataRecord(value, ["locale", "preparedWork"]);
  if (record === undefined || (record.locale !== "en" && record.locale !== "ko")) {
    return undefined;
  }
  const preparedWork = ownDataRecord(record.preparedWork, [
    "kind", "title", "content", "expectedMinutes"
  ]);
  if (
    preparedWork === undefined
    || (preparedWork.kind !== "draft" && preparedWork.kind !== "action-preview")
    || typeof preparedWork.title !== "string"
    || typeof preparedWork.content !== "string"
    || typeof preparedWork.expectedMinutes !== "number"
    || preparedWork.title.length === 0
    || preparedWork.content.length === 0
    || Array.from(preparedWork.title).length
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedTitleScalars
    || utf8Bytes(preparedWork.title)
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedTitleBytes
    || utf8Bytes(preparedWork.content)
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxPreparedContentBytes
    || PREPARED_TITLE_CONTROL.test(preparedWork.title)
    || PREPARED_CONTENT_CONTROL.test(preparedWork.content)
    || !Number.isSafeInteger(preparedWork.expectedMinutes)
    || preparedWork.expectedMinutes < 1
    || preparedWork.expectedMinutes
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxExpectedMinutes
  ) {
    return undefined;
  }
  const rawReferences = record.supportingEvidenceRefs === undefined
    ? undefined
    : ownDataArray(record.supportingEvidenceRefs);
  if (record.supportingEvidenceRefs !== undefined && rawReferences === undefined) {
    return undefined;
  }
  if (
    rawReferences !== undefined
    && rawReferences.length
      > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSupportingEvidence
  ) {
    return undefined;
  }
  const supportingEvidenceRefs = rawReferences?.map((entry) => {
    const reference = ownDataRecord(entry, [
      "artifactId", "artifactType", "providerId", "role"
    ]);
    if (
      reference === undefined
      || typeof reference.artifactId !== "string"
      || typeof reference.artifactType !== "string"
      || typeof reference.providerId !== "string"
      || typeof reference.role !== "string"
      || reference.artifactId.length === 0
      || reference.artifactType.length === 0
      || reference.providerId.length === 0
      || reference.role.length === 0
      || utf8Bytes(reference.artifactId)
        > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSourceDisplayBytes
      || utf8Bytes(reference.providerId)
        > CONTINUITY_CAPSULE_MANIFEST_LIMITS.maxSourceDisplayBytes
    ) {
      return undefined;
    }
    const artifactType = ARTIFACT_TYPES.find((candidate) =>
      candidate === reference.artifactType
    );
    const role = ARTIFACT_ROLES.find((candidate) => candidate === reference.role);
    if (
      artifactType === undefined
      || role === undefined
      || !isCoherentArtifactProvider(artifactType, reference.providerId)
    ) {
      return undefined;
    }
    return Object.freeze({
      artifactId: reference.artifactId,
      artifactType,
      providerId: reference.providerId,
      role
    });
  });
  if (supportingEvidenceRefs?.some((reference) => reference === undefined)) {
    return undefined;
  }
  const referenceKeys = new Set(supportingEvidenceRefs?.map((reference) =>
    reference === undefined ? "" : JSON.stringify([
      reference.artifactId,
      reference.artifactType,
      reference.providerId,
      reference.role
    ])
  ));
  if (referenceKeys.size !== (supportingEvidenceRefs?.length ?? 0)) return undefined;
  return Object.freeze({
    locale: record.locale,
    preparedWork: Object.freeze({
      kind: preparedWork.kind,
      title: preparedWork.title,
      content: preparedWork.content,
      expectedMinutes: preparedWork.expectedMinutes
    }),
    ...(supportingEvidenceRefs === undefined
      ? {}
      : { supportingEvidenceRefs: Object.freeze(supportingEvidenceRefs) })
  }) as ContinuityResumeRuntimeCapsuleRequestV1;
}

/**
 * Produces a Capsule only for this exact compared result object. Receipts stay
 * process-local in a WeakMap, so copied, spread, cloned, wrapped, seeded, and
 * unavailable results cannot recover them or manufacture a presentation.
 */
export function presentContinuityResumeRuntimeCapsule(
  result: unknown,
  rawRequest: unknown
): ContinuityCapsulePresentation | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const pack = CONTINUITY_RESUME_RUNTIME_RESULT_PACKS.get(result);
  const evidence = CONTINUITY_RESUME_RUNTIME_RESULT_CAPSULE_EVIDENCE.get(result);
  if (pack === undefined || evidence === undefined) return undefined;
  const request = validateContinuityResumeRuntimeCapsuleRequest(rawRequest);
  if (request === undefined) return undefined;
  try {
    return presentContinuityCapsule({
      schemaVersion: 1,
      locale: request.locale,
      invocation: { authority: "caller-declared-owner-request" },
      ...evidence,
      preparation: {
        preparedAt: evidence.currentSourceObservationReceipt.observation.observedAt,
        supportingEvidenceRefs: request.supportingEvidenceRefs ?? [],
        preparedWork: {
          ...request.preparedWork,
          actionMode: request.preparedWork.kind === "draft"
            ? "display-only"
            : "requires-new-approval"
        }
      }
    });
  } catch {
    return undefined;
  }
}

/**
 * Generates an evidence-bound, display-only draft only for this exact compared
 * result object. The four receipt dependencies stay in the same private
 * identity sidecar used by caller-declared Capsules, so copied, cloned,
 * wrapped, seeded, and unavailable values make zero provider calls.
 */
export async function prepareContinuityResumeRuntimeCapsule(
  result: unknown,
  options: ContinuityResumeRuntimeCapsulePreparationOptions
): Promise<ContinuityResumeRuntimeCapsulePreparationResultV1> {
  if (typeof result !== "object" || result === null) {
    return frozenRecord({
      schemaVersion: 1 as const,
      status: "unavailable" as const,
      reason: "invalid-exact-result" as const
    });
  }
  const pack = CONTINUITY_RESUME_RUNTIME_RESULT_PACKS.get(result);
  const evidence =
    CONTINUITY_RESUME_RUNTIME_RESULT_CAPSULE_EVIDENCE.get(result);
  if (pack === undefined || evidence === undefined) {
    return frozenRecord({
      schemaVersion: 1 as const,
      status: "unavailable" as const,
      reason: "invalid-exact-result" as const
    });
  }
  const expectedScope = safeScope(options.expectedScope);
  if (
    expectedScope === undefined
    || !sameScope(
      expectedScope,
      evidence.previousSourceObservationReceipt.scope
    )
    || !sameScope(
      expectedScope,
      evidence.currentSourceObservationReceipt.scope
    )
  ) {
    return frozenRecord({
      schemaVersion: 1 as const,
      status: "unavailable" as const,
      reason: "invalid-exact-result" as const
    });
  }
  const unsupportedSourceClasses = [
    ...new Set(
      evidence.currentSourceObservationReceipt.observation.projection
        .evidence
        .map((entry) => entry.reference.artifactType)
        .filter((artifactType) =>
          !CAPSULE_PREPARATION_SUPPORTED_SOURCE_CLASSES.has(artifactType)
        )
    )
  ].sort();
  if (unsupportedSourceClasses.length > 0) {
    return frozenRecord({
      schemaVersion: 1 as const,
      status: "unavailable" as const,
      reason: "unsupported-source-class" as const,
      unsupportedSourceClasses: Object.freeze(unsupportedSourceClasses)
    });
  }
  return prepareEvidenceBoundContinuityCapsule({
    schemaVersion: 1,
    locale: options.locale,
    modelProvider: options.modelProvider,
    model: options.model,
    previousSourceObservationReceipt:
      evidence.previousSourceObservationReceipt,
    previousGraphObservationReceipt:
      evidence.previousGraphObservationReceipt,
    currentSourceObservationReceipt:
      evidence.currentSourceObservationReceipt,
    currentGraphObservationReceipt:
      evidence.currentGraphObservationReceipt,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs })
  });
}

function bindResultCapsuleEvidence<T extends ContinuityResumeRuntimeComparedV1>(
  result: T,
  evidence: ContinuityResumeRuntimeCapsuleEvidence
): T {
  CONTINUITY_RESUME_RUNTIME_RESULT_CAPSULE_EVIDENCE.set(result, evidence);
  return result;
}

function safeScope(
  input: unknown
): Readonly<ContinuityScopedSourceObservationScope> | undefined {
  try {
    if (typeof input !== "object" || input === null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(descriptors).length !== 2
      || !("sourceId" in descriptors)
      || !("threadId" in descriptors)
    ) {
      return undefined;
    }
    const sourceDescriptor = descriptors.sourceId;
    const threadDescriptor = descriptors.threadId;
    if (
      sourceDescriptor === undefined
      || threadDescriptor === undefined
      || !("value" in sourceDescriptor)
      || !("value" in threadDescriptor)
      || typeof sourceDescriptor.value !== "string"
      || typeof threadDescriptor.value !== "string"
      || !SOURCE_ID_PATTERN.test(sourceDescriptor.value)
      || threadDescriptor.value.length === 0
      || Buffer.byteLength(threadDescriptor.value, "utf8") > 1_024
    ) {
      return undefined;
    }
    return frozenRecord({
      sourceId: sourceDescriptor.value,
      threadId: threadDescriptor.value
    }) as Readonly<ContinuityScopedSourceObservationScope>;
  } catch {
    return undefined;
  }
}

function scopeKey(scope: ContinuityScopedSourceObservationScope): string {
  return JSON.stringify([scope.sourceId, scope.threadId]);
}

function sameScope(
  left: ContinuityScopedSourceObservationScope,
  right: ContinuityScopedSourceObservationScope
): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

export function verifyContinuityResumeRuntimeBaseline(
  input: unknown
): ContinuityResumeRuntimeBaselineV1 {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("baseline must be a record");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const expected = [
      "schemaVersion",
      "baselineVersion",
      "scope",
      "boundary",
      "sourceObservationReceipt",
      "graphObservationReceipt"
    ] as const;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expected.length
      || keys.some((key) =>
        typeof key !== "string"
        || !expected.includes(key as (typeof expected)[number])
        || !("value" in descriptors[key]!)
      )
    ) {
      throw new TypeError("baseline fields are invalid");
    }
    if (
      descriptors.schemaVersion?.value !== 1
      || descriptors.baselineVersion?.value
        !== CONTINUITY_RESUME_RUNTIME_BASELINE_VERSION
    ) {
      throw new TypeError("baseline version is unsupported");
    }
    const scope = safeScope(descriptors.scope?.value);
    if (scope === undefined) throw new TypeError("baseline scope is invalid");
    const verified =
      verifyContinuityResumeBoundaryWithDependencies({
        boundary: descriptors.boundary?.value,
        previousSourceObservationReceipt:
          descriptors.sourceObservationReceipt?.value,
        previousGraphObservationReceipt:
          descriptors.graphObservationReceipt?.value
      });
    if (
      !sameScope(scope, verified.boundary.scope)
      || !sameScope(
        scope,
        verified.previousSourceObservationReceipt.scope
      )
    ) {
      throw new TypeError("baseline scope does not match its evidence");
    }
    return frozenRecord({
      schemaVersion: 1 as const,
      baselineVersion: CONTINUITY_RESUME_RUNTIME_BASELINE_VERSION,
      scope,
      boundary: verified.boundary,
      sourceObservationReceipt:
        verified.previousSourceObservationReceipt,
      graphObservationReceipt:
        verified.previousGraphObservationReceipt
    }) as ContinuityResumeRuntimeBaselineV1;
  } catch (cause) {
    throw new TypeError("Continuity resume baseline is invalid", {
      cause
    });
  }
}

function exactCurrentEvidence(
  scope: ContinuityScopedSourceObservationScope,
  capture: ContinuityResumeRuntimeCaptureV1
): Readonly<{
  source: ContinuityScopedSourceObservationReceipt;
  provider: Extract<ProviderHeadRevalidatedGraphEvidenceV1, {
    readonly status: "partial";
  }>;
  graph: ContinuityObservationReceipt;
}> | undefined {
  const rawProvider = capture.currentProviderResult;
  if (!isProcessMintedProviderHeadRevalidatedGraphEvidence(rawProvider)) {
    return undefined;
  }
  const provider = rawProvider as ProviderHeadRevalidatedGraphEvidenceV1;
  if (provider.status !== "partial") return undefined;
  const source = verifyScopedContinuitySourceObservation(
    capture.currentSourceObservationReceipt
  );
  const graph = verifyContinuityObservation(provider.graphObservationReceipt);
  if (
    !sameScope(scope, source.scope)
    || !sameScope(scope, provider.receipt.providerScope)
    || !continuitySourceGraphPairMatches(source, graph)
  ) {
    return undefined;
  }
  return frozenRecord({ source, provider, graph }) as Readonly<{
    source: ContinuityScopedSourceObservationReceipt;
    provider: Extract<ProviderHeadRevalidatedGraphEvidenceV1, {
      readonly status: "partial";
    }>;
    graph: ContinuityObservationReceipt;
  }>;
}

export function createContinuityResumeRuntimeCaptureAdapter(
  dependencies: ContinuityResumeRuntimeCaptureAdapterDependencies
): ContinuityResumeRuntimeCoordinatorDependencies["captureCurrent"] {
  return async (scope) => {
    const artifact = await dependencies.captureHeadRevalidation(scope, {
      maxCaptureSpanMs:
        CONTINUITY_RESUME_RUNTIME_LIMITS.maxCaptureSpanMs
    });
    const verified =
      verifyMintedLocalAttunementSnapshotHeadRevalidation(artifact);
    const currentProviderResult =
      await compileHeadRevalidatedProviderBoundGraphEvidence(artifact);
    if (currentProviderResult.status !== "partial") {
      return frozenRecord({
        currentProviderResult
      }) as ContinuityResumeRuntimeCaptureV1;
    }
    if (verified.subjectCapture.status !== "available") {
      throw new Error("fresh Provider subject capture is unavailable");
    }
    const currentObservedAt =
      currentProviderResult.graphObservationReceipt.observedAt;
    const nowMs = Date.parse(currentObservedAt);
    if (!Number.isFinite(nowMs)) {
      throw new Error("Provider Graph observation time is invalid");
    }
    const state = parseAttunementState(
      JSON.parse(verified.subjectCapture.normalizedStateJson) as unknown
    );
    const preparedPack = await prepareContinuityPack(
      state,
      scope.threadId,
      dependencies.resolveExactArtifact,
      { now: () => nowMs }
    );
    // This Pack evaluates external exact-artifact reads at graph.observedAt, but
    // those reads are not an atomic snapshot with the Attunement subject state.
    // Clone away resolver ownership and freeze the bounded evidence snapshot;
    // downstream authority remains explicitly partial and non-actuating.
    const pack = deepFreeze(
      structuredClone(preparedPack) as ContinuityPack
    );
    const currentSourceObservationReceipt =
      captureScopedContinuitySourceObservation({
        observedAt: currentObservedAt,
        pack,
        scope
      });
    const capture = frozenRecord({
      currentProviderResult,
      currentSourceObservationReceipt
    }) as ContinuityResumeRuntimeCaptureV1;
    CONTINUITY_RESUME_RUNTIME_CAPTURE_PACKS.set(capture, pack);
    return capture;
  };
}

function baselineFrom(
  source: ContinuityScopedSourceObservationReceipt,
  graph: ContinuityObservationReceipt
): Baseline {
  return frozenRecord({
    schemaVersion: 1 as const,
    baselineVersion: CONTINUITY_RESUME_RUNTIME_BASELINE_VERSION,
    scope: source.scope,
    boundary: captureContinuityResumeBoundary({
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    }),
    sourceObservationReceipt: source,
    graphObservationReceipt: graph
  }) as Baseline;
}

function compared(
  state: ContinuityResumeRuntimeComparedV1["state"],
  result: Extract<
    ReturnType<typeof compileContinuityResumeContext>,
    { readonly status: "partial" }
  >
): ContinuityResumeRuntimeComparedV1 {
  return frozenRecord({
    schemaVersion: 1 as const,
    status: "partial" as const,
    state,
    comparisonStatus: result.comparisonStatus,
    witnessStatus: result.witnessStatus,
    resumeContextFacts: result.agentContext.resumeContextFacts,
    supportingFacts: result.agentContext.supportingFacts,
    authority: AUTHORITY
  }) as ContinuityResumeRuntimeComparedV1;
}

export function createContinuityResumeRuntimeCoordinator(
  dependencies: ContinuityResumeRuntimeCoordinatorDependencies
): ContinuityResumeRuntimeCoordinator {
  const baselines = new Map<string, Baseline>();
  const busy = new Map<string, BusyToken>();
  const now = dependencies.monotonicNowMs ?? Date.now;
  const coordinatorIdentity = Object.freeze({});
  let inFlight = 0;

  function retain(key: string, baseline: Baseline): void {
    baselines.delete(key);
    baselines.set(key, baseline);
    while (baselines.size > CONTINUITY_RESUME_RUNTIME_LIMITS.maxBaselines) {
      const oldest = baselines.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      baselines.delete(oldest);
    }
  }

  async function preview(
    rawScope: ContinuityScopedSourceObservationScope
  ): Promise<ContinuityResumeRuntimeResultV1> {
    const scope = safeScope(rawScope);
    if (scope === undefined) return unavailable("invalid-scope");
    const key = scopeKey(scope);
    if (busy.has(key)) return unavailable("runtime-busy");
    if (inFlight >= CONTINUITY_RESUME_RUNTIME_LIMITS.maxInFlight) {
      return unavailable("runtime-capacity");
    }

    const token: BusyToken = { active: true };
    const capturedProcessBaseline = baselines.get(key);
    const baselineStore = dependencies.baselineStore;
    const baselineDurability = baselineStore === undefined
      ? "process-local" as const
      : "durable-local" as const;
    let projection: ContinuityResumeRuntimeMutationReceiptV1["effects"][number]["outcome"] =
      "not-attempted";
    let baseline: ContinuityResumeRuntimeMutationReceiptV1["effects"][number]["outcome"] =
      "not-attempted";
    const currentMutationReceipt = () => mutationReceipt(
      projection,
      baseline,
      baselineDurability
    );
    const unavailableAfterMutation = (
      reason: ContinuityResumeRuntimeUnavailableReason
    ) => bindResultMutationReceipt(unavailable(reason), currentMutationReceipt());
    let capturedBaseline = capturedProcessBaseline;
    let startedAt = now();
    busy.set(key, token);
    inFlight += 1;
    let baselineLoadFailed = false;
    let captureSettled = false;
    let previewSettled = false;
    const releaseBusyIfSettled = (): void => {
      if (
        captureSettled
        && previewSettled
        && busy.get(key) === token
      ) {
        busy.delete(key);
      }
    };
    const capturePromise = (
      baselineStore === undefined
        ? Promise.resolve()
            .then(() => dependencies.captureCurrent(scope))
        : Promise.resolve()
            .then(async () => {
              let loaded: unknown | undefined;
              try {
                loaded = await baselineStore.load(scope);
              } catch {
                baselineLoadFailed = true;
                throw new Error("continuity-resume-baseline-load-failed");
              }
              if (!token.active || busy.get(key) !== token) {
                throw new Error("continuity-resume-runtime-generation-changed");
              }
              if (loaded === undefined) {
                capturedBaseline = undefined;
              } else {
                try {
                  const verified =
                    verifyContinuityResumeRuntimeBaseline(loaded);
                  if (!sameScope(scope, verified.scope)) {
                    throw new TypeError("loaded baseline scope mismatch");
                  }
                  capturedBaseline = verified;
                } catch {
                  baselineLoadFailed = true;
                  throw new Error("continuity-resume-baseline-invalid");
                }
              }
              startedAt = now();
              return dependencies.captureCurrent(scope);
            })
    )
      .finally(() => {
        captureSettled = true;
        inFlight -= 1;
        releaseBusyIfSettled();
      });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("continuity-resume-runtime-timeout")),
        CONTINUITY_RESUME_RUNTIME_LIMITS.operationTimeoutMs
      );
    });

    try {
      let capture: ContinuityResumeRuntimeCaptureV1;
      try {
        capture = await Promise.race([capturePromise, timeoutPromise]);
      } catch (cause) {
        token.active = false;
        if (
          cause instanceof Error
          && cause.message === "continuity-resume-runtime-timeout"
        ) {
          return unavailableAfterMutation("operation-timeout");
        }
        if (baselineLoadFailed) {
          return unavailableAfterMutation("baseline-store-unavailable");
        }
        if (
          cause instanceof Error
          && cause.message
            === "continuity-resume-runtime-generation-changed"
        ) {
          return unavailableAfterMutation("runtime-generation-changed");
        }
        return unavailableAfterMutation("capture-failed");
      }
      if (timeout !== undefined) clearTimeout(timeout);
      const captureSpanMs = now() - startedAt;
      if (
        captureSpanMs < 0
        || captureSpanMs
          > CONTINUITY_RESUME_RUNTIME_LIMITS.maxCaptureSpanMs
      ) {
        token.active = false;
        return unavailableAfterMutation("capture-span-exceeded");
      }

      let current;
      try {
        if (
          !isProcessMintedProviderHeadRevalidatedGraphEvidence(
            capture.currentProviderResult
          )
        ) {
          return unavailableAfterMutation("current-evidence-invalid");
        }
        if (capture.currentProviderResult.status !== "partial") {
          return unavailableAfterMutation("provider-not-partial");
        }
        current = exactCurrentEvidence(scope, capture);
      } catch {
        return unavailableAfterMutation("current-evidence-invalid");
      }
      if (current === undefined) return unavailableAfterMutation("current-evidence-invalid");
      const revalidation = current.provider.revalidationReceipt;
      if (
        !("captureSpanMs" in revalidation)
        || typeof revalidation.captureSpanMs !== "number"
      ) {
        return unavailableAfterMutation("current-evidence-invalid");
      }
      const providerSpan = revalidation.captureSpanMs;
      if (
        providerSpan < 0
        || providerSpan
          > CONTINUITY_RESUME_RUNTIME_LIMITS.maxCaptureSpanMs
        || revalidation.maxCaptureSpanMs
          > CONTINUITY_RESUME_RUNTIME_LIMITS.maxCaptureSpanMs
      ) {
        return unavailableAfterMutation("capture-span-exceeded");
      }
      if (!token.active || busy.get(key) !== token) {
        return unavailableAfterMutation("runtime-generation-changed");
      }
      if (baselines.get(key) !== capturedProcessBaseline) {
        return unavailableAfterMutation("runtime-generation-changed");
      }

      if (capturedBaseline !== undefined) {
        const previousAt =
          capturedBaseline.graphObservationReceipt.observedAt;
        const currentAt = current.graph.observedAt;
        if (currentAt < previousAt) {
          return unavailableAfterMutation("observation-regressed");
        }
        const sameSource =
          current.source.receiptId
            === capturedBaseline.sourceObservationReceipt.receiptId;
        const sameGraph =
          current.graph.receiptId
            === capturedBaseline.graphObservationReceipt.receiptId;
        if (currentAt === previousAt && (!sameSource || !sameGraph)) {
          return unavailableAfterMutation("observation-conflict");
        }
      }

      if (dependencies.projectCurrentGraphObservation !== undefined) {
        try {
          projection = (
            await dependencies.projectCurrentGraphObservation(current.graph)
          ).status === "projected"
            ? "committed"
            : "unchanged";
        } catch {
          projection = "outcome-unknown";
          return unavailableAfterMutation("graph-projection-failed");
        }
      }
      if (
        !token.active
        || baselines.get(key) !== capturedProcessBaseline
      ) {
        return unavailableAfterMutation("runtime-generation-changed");
      }

      const commitBaseline = async (
        expectedBoundaryId: string | undefined,
        next: Baseline
      ): Promise<ContinuityResumeRuntimeUnavailableReason | undefined> => {
        if (
          !token.active
          || busy.get(key) !== token
          || baselines.get(key) !== capturedProcessBaseline
        ) {
          return "runtime-generation-changed";
        }
        if (dependencies.baselineStore !== undefined) {
          let outcome: "stored" | "unchanged" | "conflict";
          try {
            outcome = await dependencies.baselineStore.compareAndSet(
              scope,
              expectedBoundaryId,
              next
            );
          } catch {
            baseline = "outcome-unknown";
            return "baseline-store-unavailable";
          }
          if (outcome === "conflict") {
            baseline = "conflict";
            return "runtime-generation-changed";
          }
          if (outcome !== "stored" && outcome !== "unchanged") {
            baseline = "outcome-unknown";
            return "baseline-store-unavailable";
          }
          baseline = outcome === "stored" ? "committed" : "unchanged";
          if (
            !token.active
            || busy.get(key) !== token
            || baselines.get(key) !== capturedProcessBaseline
          ) {
            return "runtime-generation-changed";
          }
        } else {
          baseline = capturedBaseline?.boundary.boundaryId
            === next.boundary.boundaryId
            ? "unchanged"
            : "committed";
        }
        retain(key, next);
        return undefined;
      };

      if (capturedBaseline === undefined) {
        let next: Baseline;
        try {
          next = baselineFrom(current.source, current.graph);
        } catch {
          return unavailableAfterMutation("resume-context-unavailable");
        }
        const commitFailure = await commitBaseline(undefined, next);
        if (commitFailure !== undefined) return unavailableAfterMutation(commitFailure);
        const durable = dependencies.baselineStore !== undefined;
        return bindResultPack(
          bindResultMutationReceipt(
            frozenRecord({
              schemaVersion: 1 as const,
              status: "partial" as const,
              state: durable
                ? "durable-baseline-seeded" as const
                : "process-local-baseline-seeded" as const,
              reason: durable
                ? "no-prior-durable-baseline" as const
                : "no-prior-process-local-baseline" as const,
              authority: AUTHORITY
            }) as ContinuityResumeRuntimeSeededV1,
            currentMutationReceipt()
          ),
          capture
        );
      }

      const previousAt =
        capturedBaseline.graphObservationReceipt.observedAt;
      const currentAt = current.graph.observedAt;

      let result: ReturnType<typeof compileContinuityResumeContext>;
      try {
        result = compileContinuityResumeContext({
          schemaVersion: 1,
          boundary: capturedBaseline.boundary,
          previousSourceObservationReceipt:
            capturedBaseline.sourceObservationReceipt,
          previousGraphObservationReceipt:
            capturedBaseline.graphObservationReceipt,
          currentProviderResult: current.provider,
          currentSourceObservationReceipt: current.source,
          budget: RESUME_BUDGET
        });
      } catch {
        return unavailableAfterMutation("resume-context-unavailable");
      }
      if (result.status !== "partial") {
        return unavailableAfterMutation("resume-context-unavailable");
      }
      const audit = getContinuityResumeContextAudit(result);
      if (
        audit === undefined
        || audit.currentProviderResult !== current.provider
        || audit.currentSourceObservationReceipt.receiptId
          !== current.source.receiptId
        || audit.currentGraphObservationReceipt.receiptId
          !== current.graph.receiptId
        || audit.previous.boundary.boundaryId
          !== capturedBaseline.boundary.boundaryId
        || audit.previous.previousSourceObservationReceipt.receiptId
          !== capturedBaseline.sourceObservationReceipt.receiptId
        || audit.previous.previousGraphObservationReceipt.receiptId
          !== capturedBaseline.graphObservationReceipt.receiptId
      ) {
        return unavailableAfterMutation("resume-context-unavailable");
      }
      if (
        !token.active
        || baselines.get(key) !== capturedProcessBaseline
      ) {
        return unavailableAfterMutation("runtime-generation-changed");
      }

      if (currentAt === previousAt) {
        const commitFailure = await commitBaseline(
          capturedBaseline.boundary.boundaryId,
          capturedBaseline
        );
        if (commitFailure !== undefined) return unavailableAfterMutation(commitFailure);
        const comparedResult = bindResultCapsuleEvidence(
          bindResultPack(
            bindResultMutationReceipt(
              compared("compared-with-baseline-reused", result),
              currentMutationReceipt()
            ),
            capture
          ),
          frozenRecord({
            previousSourceObservationReceipt:
              capturedBaseline.sourceObservationReceipt,
            previousGraphObservationReceipt:
              capturedBaseline.graphObservationReceipt,
            currentSourceObservationReceipt: current.source,
            currentGraphObservationReceipt: current.graph
          }) as ContinuityResumeRuntimeCapsuleEvidence
        );
        const pack = CONTINUITY_RESUME_RUNTIME_RESULT_PACKS.get(comparedResult);
        if (pack === undefined) return comparedResult;
        return bindAttuneGraphShadowDecisionRuntimeEvidence(comparedResult, {
          coordinator: coordinatorIdentity,
          pack,
          packDigest: digestRuntimeEvidence(pack),
          resumeResultDigest: digestRuntimeEvidence(comparedResult),
          previousSourceObservationReceipt:
            capturedBaseline.sourceObservationReceipt,
          previousGraphObservationReceipt:
            capturedBaseline.graphObservationReceipt,
          currentSourceObservationReceipt: current.source,
          currentGraphObservationReceipt: current.graph
        });
      }
      let next: Baseline;
      try {
        next = baselineFrom(current.source, current.graph);
      } catch {
        return unavailableAfterMutation("resume-context-unavailable");
      }
      if (
        !token.active
        || baselines.get(key) !== capturedProcessBaseline
      ) {
        return unavailableAfterMutation("runtime-generation-changed");
      }
      const commitFailure = await commitBaseline(
        capturedBaseline.boundary.boundaryId,
        next
      );
      if (commitFailure !== undefined) return unavailableAfterMutation(commitFailure);
      const comparedResult = bindResultCapsuleEvidence(
        bindResultPack(
          bindResultMutationReceipt(
            compared("compared-and-advanced", result),
            currentMutationReceipt()
          ),
          capture
        ),
        frozenRecord({
          previousSourceObservationReceipt:
            capturedBaseline.sourceObservationReceipt,
          previousGraphObservationReceipt:
            capturedBaseline.graphObservationReceipt,
          currentSourceObservationReceipt: current.source,
          currentGraphObservationReceipt: current.graph
        }) as ContinuityResumeRuntimeCapsuleEvidence
      );
      const pack = CONTINUITY_RESUME_RUNTIME_RESULT_PACKS.get(comparedResult);
      if (pack === undefined) return comparedResult;
      return bindAttuneGraphShadowDecisionRuntimeEvidence(comparedResult, {
        coordinator: coordinatorIdentity,
        pack,
        packDigest: digestRuntimeEvidence(pack),
        resumeResultDigest: digestRuntimeEvidence(comparedResult),
        previousSourceObservationReceipt:
          capturedBaseline.sourceObservationReceipt,
        previousGraphObservationReceipt:
          capturedBaseline.graphObservationReceipt,
        currentSourceObservationReceipt: current.source,
        currentGraphObservationReceipt: current.graph
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      previewSettled = true;
      if (!captureSettled) token.active = false;
      releaseBusyIfSettled();
    }
  }

  return bindAttuneGraphShadowDecisionCoordinator(
    frozenRecord({ preview }) as ContinuityResumeRuntimeCoordinator,
    coordinatorIdentity
  );
}
