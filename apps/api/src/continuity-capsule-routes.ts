import type {
  ContinuityCapsulePreparationService,
  ContinuityCapsulePreparationServiceResult
} from "@muse/autoconfigure";
import type { FastifyInstance } from "fastify";

import { createHttpRequestAbortScope } from "./http-request-abort.js";
import { requireAuthenticated } from "./server-helpers.js";
import type { ServerOptions } from "./server-options.js";

const THREAD_ID_PATTERN =
  /^thread_[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u;

export type ContinuityCapsulePublicUnavailableReason =
  | "service-not-configured"
  | "invalid-request"
  | "thread-not-found"
  | "unsupported-source-class"
  | "source-unavailable"
  | "busy"
  | "capacity"
  | "model-not-configured"
  | "comparison-unavailable"
  | "provider-unavailable"
  | "provider-timeout"
  | "preparation-unavailable"
  | "presentation-unavailable";

export interface ContinuityCapsuleDisplaySource {
  readonly observation: "previous" | "current";
  readonly status: "available" | "unavailable";
  readonly title?: string;
  readonly summary?: string;
}

export type ContinuityCapsulePrepareResponse =
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "seeded";
      readonly baselineDurability:
        | "durable-local"
        | "process-local-only";
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "unavailable";
      readonly reason: ContinuityCapsulePublicUnavailableReason;
    }>
  | Readonly<{
      readonly schemaVersion: 1;
      readonly status: "ready";
      readonly capsule: {
        readonly locale: "en" | "ko";
        readonly headline: string;
        readonly threadTitle: string;
        readonly timingCaveat: string;
        readonly stoppedPoint: {
          readonly heading: string;
          readonly observedAt: string;
          readonly currentAvailability: "available" | "unavailable";
          readonly source: ContinuityCapsuleDisplaySource;
        };
        readonly changes: {
          readonly status: "complete" | "partial" | "no-change" | "abstained";
          readonly summary: string;
          readonly items: readonly {
            readonly relationLabel: string;
            readonly kindLabel: string;
            readonly bindingLabel: string;
          }[];
          readonly abstentions: readonly {
            readonly label: string;
            readonly affectedCount: number;
            readonly affectedCountUnit: "assertions" | "candidates";
          }[];
        };
        readonly nextStep: {
          readonly heading: string;
          readonly source: ContinuityCapsuleDisplaySource;
        };
        readonly preparedWork: {
          readonly heading: string;
          readonly title: string;
          readonly content: string;
          readonly expectedMinutes: number;
          readonly expectedMinutesSemantics: "estimate";
          readonly actionBoundary: string;
          readonly textOrigin: "model-generated-proposal";
          readonly entailment: "not-verified";
        };
        readonly disclosure: {
          readonly heading: string;
          readonly whyShown: string;
          readonly privacyNotice: string;
          readonly previousObservedAt: string;
          readonly currentObservedAt: string;
          readonly preparedAt: string;
          readonly generatedAt: string;
          readonly verification: "citation-binding-verified";
          readonly authenticatedWitness: "not-proven";
          readonly sourceFreshness: "not-proven";
          readonly currentWorldTruth: "not-granted";
          readonly sourceCompleteness: "not-granted";
          readonly actionAuthority: "not-granted";
          readonly sources: readonly ContinuityCapsuleDisplaySource[];
          readonly graphSources: {
            readonly total: number;
            readonly displayed: number;
            readonly omitted: number;
          };
        };
      };
    }>;

export interface ContinuityCapsuleRoutesGate {
  readonly authService: ServerOptions["authService"];
  readonly preparation?: Pick<
    ContinuityCapsulePreparationService,
    "prepare"
  >;
}

type CapsuleBodyParseResult =
  | Readonly<{ readonly locale: "en" | "ko" }>
  | Readonly<{ readonly errorMessage: string }>;

function isPlainRecord(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseContinuityCapsuleRequest(
  threadId: unknown,
  body: unknown
): CapsuleBodyParseResult {
  if (
    typeof threadId !== "string"
    || !THREAD_ID_PATTERN.test(threadId)
  ) {
    return { errorMessage: "continuity capsule thread id is invalid" };
  }
  if (!isPlainRecord(body)) {
    return { errorMessage: "continuity capsule body must contain exactly locale" };
  }
  const descriptors = Object.getOwnPropertyDescriptors(body);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== 1
    || keys[0] !== "locale"
    || !("value" in descriptors.locale!)
  ) {
    return { errorMessage: "continuity capsule body must contain exactly locale" };
  }
  const locale = descriptors.locale.value;
  if (locale !== "en" && locale !== "ko") {
    return { errorMessage: "continuity capsule locale must be en or ko" };
  }
  return { locale };
}

function unavailable(
  reason: ContinuityCapsulePublicUnavailableReason
): ContinuityCapsulePrepareResponse {
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "unavailable" as const,
    reason
  });
}

function assertNever(value: never): never {
  throw new TypeError(
    `unsupported continuity capsule variant: ${typeof value}`
  );
}

function displaySource(
  source: Extract<
    ContinuityCapsulePreparationServiceResult,
    { readonly status: "ready" }
  >["presentation"]["sourceDrawer"]["artifactSources"][number]
): ContinuityCapsuleDisplaySource {
  return Object.freeze({
    observation: source.observation,
    status: source.status,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.summary === undefined ? {} : { summary: source.summary })
  });
}

function sourceFor(
  presentation: Extract<
    ContinuityCapsulePreparationServiceResult,
    { readonly status: "ready" }
  >["presentation"],
  sourceKey: string,
  observation: ContinuityCapsuleDisplaySource["observation"]
): ContinuityCapsuleDisplaySource | undefined {
  const matches = presentation.sourceDrawer.artifactSources.filter(
    (source) =>
      source.sourceKey === sourceKey
      && source.observation === observation
  );
  return matches.length === 1 ? displaySource(matches[0]!) : undefined;
}

function projectReady(
  result: Extract<
    ContinuityCapsulePreparationServiceResult,
    { readonly status: "ready" }
  >
): ContinuityCapsulePrepareResponse {
  const presentation = result.presentation;
  const stoppedSource = sourceFor(
    presentation,
    presentation.resume.previousNextStepSourceKey,
    "previous"
  );
  const nextSource = sourceFor(
    presentation,
    presentation.currentNextStepSourceKey,
    "current"
  );
  if (stoppedSource === undefined || nextSource === undefined) {
    return unavailable("presentation-unavailable");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    status: "ready" as const,
    capsule: Object.freeze({
      locale: presentation.locale,
      headline: presentation.systemCopy.headline,
      threadTitle: presentation.thread.title,
      timingCaveat: presentation.systemCopy.timingCaveat,
      stoppedPoint: Object.freeze({
        heading: presentation.systemCopy.resumeHeading,
        observedAt: presentation.resume.observedAt,
        currentAvailability: presentation.resume.currentAvailability,
        source: stoppedSource
      }),
      changes: Object.freeze({
        status: presentation.changeSummary.status,
        summary: presentation.systemCopy.changeSummary,
        items: Object.freeze(
          presentation.changes.map((change) => Object.freeze({
            relationLabel: change.systemCopy.relationLabel,
            kindLabel: change.systemCopy.kindLabel,
            bindingLabel: change.systemCopy.bindingLabel
          }))
        ),
        abstentions: Object.freeze(
          presentation.abstentions.map((abstention) => Object.freeze({
            label: abstention.systemCopy.label,
            affectedCount: abstention.affectedCount,
            affectedCountUnit: abstention.affectedCountUnit
          }))
        )
      }),
      nextStep: Object.freeze({
        heading: presentation.systemCopy.currentNextStepHeading,
        source: nextSource
      }),
      preparedWork: Object.freeze({
        heading: presentation.systemCopy.preparedHeading,
        title: presentation.preparedWork.title,
        content: presentation.preparedWork.content,
        expectedMinutes: presentation.preparedWork.expectedMinutes,
        expectedMinutesSemantics:
          presentation.preparedWork.expectedMinutesSemantics,
        actionBoundary: presentation.systemCopy.actionBoundary,
        textOrigin: presentation.preparedWork.textOrigin,
        entailment: presentation.authority.entailment
      }),
      disclosure: Object.freeze({
        heading: presentation.systemCopy.sourceHeading,
        whyShown: presentation.systemCopy.whyShown,
        privacyNotice: presentation.systemCopy.privacyNotice,
        previousObservedAt:
          presentation.sourceDrawer.previousObservedAt,
        currentObservedAt:
          presentation.sourceDrawer.currentObservedAt,
        preparedAt: presentation.sourceDrawer.preparedAt,
        generatedAt: presentation.sourceDrawer.generatedAt,
        verification: presentation.verification,
        authenticatedWitness:
          presentation.authority.authenticatedWitness,
        sourceFreshness: presentation.authority.sourceFreshness,
        currentWorldTruth: presentation.authority.currentWorldTruth,
        sourceCompleteness: presentation.authority.sourceCompleteness,
        actionAuthority: presentation.authority.actionAuthority,
        sources: Object.freeze(
          presentation.sourceDrawer.artifactSources.map(displaySource)
        ),
        graphSources: Object.freeze({
          total: presentation.sourceDrawer.graphSources.total,
          displayed: presentation.sourceDrawer.graphSources.displayed,
          omitted: presentation.sourceDrawer.graphSources.omitted
        })
      })
    })
  });
}

function projectPreparationUnavailable(
  reason: Extract<
    ContinuityCapsulePreparationServiceResult,
    { readonly reason: "model-preparation-unavailable" }
  >["preparationReason"]
): ContinuityCapsulePublicUnavailableReason {
  switch (reason) {
    case "provider-timeout":
      return "provider-timeout";
    case "provider-cancelled":
    case "provider-failed":
    case "provider-model-mismatch":
    case "provider-output-invalid":
      return "provider-unavailable";
    case "invalid-exact-result":
      return "comparison-unavailable";
    case "unsupported-source-class":
      return "unsupported-source-class";
    case "invalid-dependency":
    case "evidence-budget-exceeded":
    case "generation-time-regressed":
      return "preparation-unavailable";
    default:
      return assertNever(reason);
  }
}

export function projectContinuityCapsuleResponse(
  result: ContinuityCapsulePreparationServiceResult
): ContinuityCapsulePrepareResponse {
  if (result.status === "ready") return projectReady(result);
  if (result.status === "seeded") {
    return Object.freeze({
      schemaVersion: 1,
      status: "seeded",
      baselineDurability: result.baselineDurability
    });
  }
  switch (result.reason) {
    case "invalid-request":
      return unavailable("invalid-request");
    case "thread-not-found":
      return unavailable("thread-not-found");
    case "source-state-unavailable":
      return unavailable("source-unavailable");
    case "scope-busy":
      return unavailable("busy");
    case "service-capacity":
      return unavailable("capacity");
    case "model-not-configured":
      return unavailable("model-not-configured");
    case "unsupported-source-class":
      return unavailable("unsupported-source-class");
    case "resume-runtime-unavailable":
      return unavailable("comparison-unavailable");
    case "model-preparation-unavailable":
      return unavailable(
        projectPreparationUnavailable(result.preparationReason)
      );
    default:
      return assertNever(result);
  }
}

export function registerContinuityCapsuleRoutes(
  server: FastifyInstance,
  gate: ContinuityCapsuleRoutesGate
): void {
  server.post<{
    readonly Params: { readonly threadId: string };
    readonly Body: unknown;
  }>(
    "/api/attunement/threads/:threadId/capsule/prepare",
    {
      onRequest: async (_request, reply) => {
        reply.header("cache-control", "private, no-store");
      }
    },
    async (request, reply) => {
      if (
        !requireAuthenticated(
          request,
          reply,
          Boolean(gate.authService)
        )
      ) {
        return reply;
      }
      const parsed = parseContinuityCapsuleRequest(
        request.params.threadId,
        request.body
      );
      if ("errorMessage" in parsed) {
        return reply.code(400).send(parsed);
      }
      if (gate.preparation === undefined) {
        return unavailable("service-not-configured");
      }

      const abortScope = createHttpRequestAbortScope(request, reply);
      try {
        if (abortScope.signal.aborted) return reply;
        const result = await gate.preparation.prepare({
          threadId: request.params.threadId,
          locale: parsed.locale,
          signal: abortScope.signal
        });
        if (abortScope.signal.aborted) return reply;
        return projectContinuityCapsuleResponse(result);
      } catch {
        if (abortScope.signal.aborted) return reply;
        return reply.code(500).send({
          errorMessage: "continuity capsule preparation is unavailable"
        });
      } finally {
        abortScope.dispose();
      }
    }
  );
}
