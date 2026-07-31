import {
  readAttunementState,
  type ArtifactType
} from "@muse/attunement";
import {
  prepareContinuityResumeRuntimeCapsule,
  type ContinuityResumeRuntimeCapsulePreparationResultV1,
  type ContinuityResumeRuntimeCoordinator,
  type ContinuityResumeRuntimeUnavailableReason
} from "@muse/attunegraph/continuity-resume-runtime";
import type { ModelProvider } from "@muse/model";

const SUPPORTED_SOURCE_CLASSES = new Set<ArtifactType>([
  "task",
  "note",
  "reminder"
]);
const THREAD_ID_PATTERN =
  /^thread_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

export const CONTINUITY_CAPSULE_PREPARATION_SERVICE_LIMITS =
  Object.freeze({
    maxInFlight: 4
  });

type ServiceToken = {
  activeProviderCalls: number;
  requestSettled: boolean;
};

export interface ContinuityCapsulePreparationRequest {
  readonly threadId: string;
  readonly locale: "en" | "ko";
  readonly signal?: AbortSignal;
}

export type ContinuityCapsulePreparationServiceResult =
  | Extract<
      ContinuityResumeRuntimeCapsulePreparationResultV1,
      { readonly status: "ready" }
    >
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "seeded";
      readonly state: "process-local-baseline-seeded";
      readonly reason: "no-prior-process-local-baseline";
      readonly baselineDurability: "process-local-only";
      readonly authority: {
        readonly canAssertCurrentWorldTruth: false;
        readonly canAssertSourceCompleteness: false;
        readonly canGrantActionAuthority: false;
      };
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "unavailable";
      readonly reason:
        | "invalid-request"
        | "thread-not-found"
        | "source-state-unavailable"
        | "scope-busy"
        | "service-capacity"
        | "model-not-configured";
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
      readonly reason: "resume-runtime-unavailable";
      readonly runtimeReason: ContinuityResumeRuntimeUnavailableReason;
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "unavailable";
      readonly reason: "model-preparation-unavailable";
      readonly preparationReason: Extract<
        ContinuityResumeRuntimeCapsulePreparationResultV1,
        { readonly status: "unavailable" }
      >["reason"];
    }>;

export interface ContinuityCapsulePreparationService {
  prepare(
    request: ContinuityCapsulePreparationRequest
  ): Promise<ContinuityCapsulePreparationServiceResult>;
}

export interface CreateContinuityCapsulePreparationServiceOptions {
  readonly attunementFile: string;
  readonly sourceId: string;
  readonly resumeCoordinator: ContinuityResumeRuntimeCoordinator;
  readonly modelProvider?: Pick<ModelProvider, "id" | "generate">;
  readonly model?: string;
  /** @internal deterministic-test seam */
  readonly now?: () => Date;
  /** @internal deterministic-test seam */
  readonly timeoutMs?: number;
}

function unavailable(
  reason:
    | "invalid-request"
    | "thread-not-found"
    | "source-state-unavailable"
    | "scope-busy"
    | "service-capacity"
    | "model-not-configured"
): ContinuityCapsulePreparationServiceResult {
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "unavailable" as const,
    reason
  });
}

function scopeKey(sourceId: string, threadId: string): string {
  return JSON.stringify([sourceId, threadId]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createContinuityCapsulePreparationService(
  options: CreateContinuityCapsulePreparationServiceOptions
): ContinuityCapsulePreparationService {
  const inFlightScopes = new Map<string, ServiceToken>();
  let inFlight = 0;

  function releaseIfSettled(key: string, token: ServiceToken): void {
    if (
      token.requestSettled
      && token.activeProviderCalls === 0
      && inFlightScopes.get(key) === token
    ) {
      inFlightScopes.delete(key);
      inFlight -= 1;
    }
  }

  return Object.freeze({
    async prepare(
      request: ContinuityCapsulePreparationRequest
    ): Promise<ContinuityCapsulePreparationServiceResult> {
      if (
        typeof request !== "object"
        || request === null
        || !THREAD_ID_PATTERN.test(request.threadId)
        || (request.locale !== "en" && request.locale !== "ko")
      ) {
        return unavailable("invalid-request");
      }
      const key = scopeKey(options.sourceId, request.threadId);
      if (inFlightScopes.has(key)) return unavailable("scope-busy");
      if (
        inFlight
        >= CONTINUITY_CAPSULE_PREPARATION_SERVICE_LIMITS.maxInFlight
      ) {
        return unavailable("service-capacity");
      }
      const token: ServiceToken = {
        activeProviderCalls: 0,
        requestSettled: false
      };
      inFlight += 1;
      inFlightScopes.set(key, token);
      try {
        let state: Awaited<ReturnType<typeof readAttunementState>>;
        try {
          state = await readAttunementState(options.attunementFile);
        } catch {
          return unavailable("source-state-unavailable");
        }
        const matches = state.threads.filter((thread) =>
          thread.id === request.threadId
        );
        if (matches.length !== 1) return unavailable("thread-not-found");
        const unsupportedSourceClasses = [
          ...new Set(
            matches[0]!.links
              .map((link) => link.artifactType)
              .filter((artifactType) =>
                !SUPPORTED_SOURCE_CLASSES.has(artifactType)
              )
          )
        ].sort(compareText);
        if (unsupportedSourceClasses.length > 0) {
          return Object.freeze({
            schemaVersion: 1,
            status: "unavailable",
            reason: "unsupported-source-class",
            unsupportedSourceClasses: Object.freeze(
              unsupportedSourceClasses
            )
          });
        }

        const resume = await options.resumeCoordinator.preview({
          sourceId: options.sourceId,
          threadId: request.threadId
        });
        if (resume.status === "unavailable") {
          return Object.freeze({
            schemaVersion: 1,
            status: "unavailable",
            reason: "resume-runtime-unavailable",
            runtimeReason: resume.reason
          });
        }
        if (resume.state === "process-local-baseline-seeded") {
          return Object.freeze({
            schemaVersion: 1,
            status: "seeded",
            state: resume.state,
            reason: resume.reason,
            baselineDurability: "process-local-only",
            authority: resume.authority
          });
        }
        if (
          options.modelProvider === undefined
          || options.model === undefined
          || options.model.trim().length === 0
        ) {
          return unavailable("model-not-configured");
        }
        const trackedModelProvider = Object.freeze({
          id: options.modelProvider.id,
          generate: (
            modelRequest: Parameters<
              NonNullable<typeof options.modelProvider>["generate"]
            >[0]
          ) => {
            token.activeProviderCalls += 1;
            let pending: ReturnType<
              NonNullable<typeof options.modelProvider>["generate"]
            >;
            try {
              pending = options.modelProvider!.generate(modelRequest);
            } catch (cause) {
              token.activeProviderCalls -= 1;
              releaseIfSettled(key, token);
              throw cause;
            }
            const settled = Promise.resolve(pending).finally(() => {
              token.activeProviderCalls -= 1;
              releaseIfSettled(key, token);
            });
            void settled.catch(() => undefined);
            return settled;
          }
        });
        const prepared = await prepareContinuityResumeRuntimeCapsule(
          resume,
          {
            expectedScope: {
              sourceId: options.sourceId,
              threadId: request.threadId
            },
            locale: request.locale,
            modelProvider: trackedModelProvider,
            model: options.model,
            ...(request.signal === undefined
              ? {}
              : { signal: request.signal }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs })
          }
        );
        if (prepared.status === "ready") return prepared;
        if (prepared.reason === "unsupported-source-class") {
          return Object.freeze({
            schemaVersion: 1,
            status: "unavailable",
            reason: prepared.reason,
            unsupportedSourceClasses:
              prepared.unsupportedSourceClasses
          });
        }
        return Object.freeze({
          schemaVersion: 1,
          status: "unavailable",
          reason: "model-preparation-unavailable",
          preparationReason: prepared.reason
        });
      } finally {
        token.requestSettled = true;
        releaseIfSettled(key, token);
      }
    }
  });
}
