import {
  ARTIFACT_ROLES,
  ARTIFACT_TYPES,
  isCoherentArtifactProvider,
  prepareContinuityPack,
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
import { CONTINUITY_CAPSULE_MANIFEST_LIMITS } from "./continuity-capsule-manifest.js";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PREPARED_TITLE_CONTROL = /[\u0000-\u001F\u007F]/u;
const PREPARED_CONTENT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

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
  | "observation-regressed"
  | "observation-conflict"
  | "resume-context-unavailable"
  | "runtime-generation-changed";

type RuntimeAuthority = typeof AUTHORITY;

export type ContinuityResumeRuntimeUnavailableV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly status: "unavailable";
  readonly reason: ContinuityResumeRuntimeUnavailableReason;
  readonly authority: RuntimeAuthority;
}>;

export type ContinuityResumeRuntimeSeededV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly status: "partial";
  readonly state: "process-local-baseline-seeded";
  readonly reason: "no-prior-process-local-baseline";
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
  /** @internal deterministic-test seam */
  readonly monotonicNowMs?: () => number;
}

type Baseline = Readonly<{
  readonly boundary: ContinuityResumeBoundary;
  readonly source: ContinuityScopedSourceObservationReceipt;
  readonly graph: ContinuityObservationReceipt;
}>;

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
    boundary: captureContinuityResumeBoundary({
      previousSourceObservationReceipt: source,
      previousGraphObservationReceipt: graph
    }),
    source,
    graph
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
    const capturedBaseline = baselines.get(key);
    busy.set(key, token);
    inFlight += 1;
    const startedAt = now();
    let settled = false;
    const capturePromise = Promise.resolve()
      .then(() => dependencies.captureCurrent(scope))
      .finally(() => {
        settled = true;
        inFlight -= 1;
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
          return unavailable("operation-timeout");
        }
        return unavailable("capture-failed");
      }
      if (timeout !== undefined) clearTimeout(timeout);
      const captureSpanMs = now() - startedAt;
      if (
        captureSpanMs < 0
        || captureSpanMs
          > CONTINUITY_RESUME_RUNTIME_LIMITS.maxCaptureSpanMs
      ) {
        token.active = false;
        return unavailable("capture-span-exceeded");
      }

      let current;
      try {
        if (
          !isProcessMintedProviderHeadRevalidatedGraphEvidence(
            capture.currentProviderResult
          )
        ) {
          return unavailable("current-evidence-invalid");
        }
        if (capture.currentProviderResult.status !== "partial") {
          return unavailable("provider-not-partial");
        }
        current = exactCurrentEvidence(scope, capture);
      } catch {
        return unavailable("current-evidence-invalid");
      }
      if (current === undefined) return unavailable("current-evidence-invalid");
      const revalidation = current.provider.revalidationReceipt;
      if (
        !("captureSpanMs" in revalidation)
        || typeof revalidation.captureSpanMs !== "number"
      ) {
        return unavailable("current-evidence-invalid");
      }
      const providerSpan = revalidation.captureSpanMs;
      if (
        providerSpan < 0
        || providerSpan
          > CONTINUITY_RESUME_RUNTIME_LIMITS.maxCaptureSpanMs
        || revalidation.maxCaptureSpanMs
          > CONTINUITY_RESUME_RUNTIME_LIMITS.maxCaptureSpanMs
      ) {
        return unavailable("capture-span-exceeded");
      }
      if (!token.active || busy.get(key) !== token) {
        return unavailable("runtime-generation-changed");
      }
      if (baselines.get(key) !== capturedBaseline) {
        return unavailable("runtime-generation-changed");
      }

      if (capturedBaseline === undefined) {
        let next: Baseline;
        try {
          next = baselineFrom(current.source, current.graph);
        } catch {
          return unavailable("resume-context-unavailable");
        }
        if (!token.active || baselines.has(key)) {
          return unavailable("runtime-generation-changed");
        }
        retain(key, next);
        return bindResultPack(frozenRecord({
          schemaVersion: 1 as const,
          status: "partial" as const,
          state: "process-local-baseline-seeded" as const,
          reason: "no-prior-process-local-baseline" as const,
          authority: AUTHORITY
        }) as ContinuityResumeRuntimeSeededV1, capture);
      }

      const previousAt = capturedBaseline.graph.observedAt;
      const currentAt = current.graph.observedAt;
      if (currentAt < previousAt) return unavailable("observation-regressed");
      const sameSource =
        current.source.receiptId === capturedBaseline.source.receiptId;
      const sameGraph =
        current.graph.receiptId === capturedBaseline.graph.receiptId;
      if (currentAt === previousAt && (!sameSource || !sameGraph)) {
        return unavailable("observation-conflict");
      }

      let result: ReturnType<typeof compileContinuityResumeContext>;
      try {
        result = compileContinuityResumeContext({
          schemaVersion: 1,
          boundary: capturedBaseline.boundary,
          previousSourceObservationReceipt: capturedBaseline.source,
          previousGraphObservationReceipt: capturedBaseline.graph,
          currentProviderResult: current.provider,
          currentSourceObservationReceipt: current.source,
          budget: RESUME_BUDGET
        });
      } catch {
        return unavailable("resume-context-unavailable");
      }
      if (result.status !== "partial") {
        return unavailable("resume-context-unavailable");
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
          !== capturedBaseline.source.receiptId
        || audit.previous.previousGraphObservationReceipt.receiptId
          !== capturedBaseline.graph.receiptId
      ) {
        return unavailable("resume-context-unavailable");
      }
      if (!token.active || baselines.get(key) !== capturedBaseline) {
        return unavailable("runtime-generation-changed");
      }

      if (currentAt === previousAt) {
        retain(key, capturedBaseline);
        return bindResultCapsuleEvidence(
          bindResultPack(
            compared("compared-with-baseline-reused", result),
            capture
          ),
          frozenRecord({
            previousSourceObservationReceipt: capturedBaseline.source,
            previousGraphObservationReceipt: capturedBaseline.graph,
            currentSourceObservationReceipt: current.source,
            currentGraphObservationReceipt: current.graph
          }) as ContinuityResumeRuntimeCapsuleEvidence
        );
      }
      let next: Baseline;
      try {
        next = baselineFrom(current.source, current.graph);
      } catch {
        return unavailable("resume-context-unavailable");
      }
      if (!token.active || baselines.get(key) !== capturedBaseline) {
        return unavailable("runtime-generation-changed");
      }
      retain(key, next);
      return bindResultCapsuleEvidence(
        bindResultPack(
          compared("compared-and-advanced", result),
          capture
        ),
        frozenRecord({
          previousSourceObservationReceipt: capturedBaseline.source,
          previousGraphObservationReceipt: capturedBaseline.graph,
          currentSourceObservationReceipt: current.source,
          currentGraphObservationReceipt: current.graph
        }) as ContinuityResumeRuntimeCapsuleEvidence
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (!settled) token.active = false;
      if (busy.get(key) === token) busy.delete(key);
    }
  }

  return frozenRecord({ preview }) as ContinuityResumeRuntimeCoordinator;
}
