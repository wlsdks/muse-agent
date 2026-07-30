import {
  verifyScopedContinuitySourceObservation,
  type ContinuityScopedSourceObservationReceipt,
  type ContinuityScopedSourceObservationScope
} from "@muse/attunement/continuity-source-observations";

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
  isProcessMintedProviderHeadRevalidatedGraphEvidence,
  type ProviderHeadRevalidatedGraphEvidenceV1
} from "./provider-head-revalidated-graph-evidence.js";

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

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
  readonly currentSourceObservationReceipt:
    ContinuityScopedSourceObservationReceipt;
  readonly currentProviderResult: ProviderHeadRevalidatedGraphEvidenceV1;
}>;

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

function frozenRecord<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(
    Object.assign(Object.create(null) as Record<string, unknown>, value)
  ) as Readonly<T>;
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
        return frozenRecord({
          schemaVersion: 1 as const,
          status: "partial" as const,
          state: "process-local-baseline-seeded" as const,
          reason: "no-prior-process-local-baseline" as const,
          authority: AUTHORITY
        }) as ContinuityResumeRuntimeSeededV1;
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
        return compared("compared-with-baseline-reused", result);
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
      return compared("compared-and-advanced", result);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (!settled) token.active = false;
      if (busy.get(key) === token) busy.delete(key);
    }
  }

  return frozenRecord({ preview }) as ContinuityResumeRuntimeCoordinator;
}
