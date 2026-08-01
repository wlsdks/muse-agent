import {
  buildExperienceLearningReviewQueue,
  fingerprintContinuityPolicy,
  type AttunementState,
  type ContinuityDetailLevel,
  type NextStepPresentation
} from "@muse/attunement";
import type {
  AttuneGraphPolicyCardHeldReasonV1,
  AttuneGraphPolicyCardLocaleV1,
  AttuneGraphPolicyCardV1
} from "@muse/attunegraph/policy-card";

import {
  createContinuityLearningPreparationService,
  type ContinuityLearningEvaluatorInput
} from "./continuity-learning-preparation-service.js";
import type {
  ContinuityLearningPolicyCardPreviewService
} from "./continuity-learning-policy-card-preview-service.js";

const OPPORTUNITY_ID = /^learning_opportunity_[a-f0-9]{64}$/u;
const PREPARATION_TIMEOUT_MS = 1_000;

export interface OwnerTaughtPolicyCardPreviewInput {
  readonly detail: ContinuityDetailLevel;
  readonly locale: AttuneGraphPolicyCardLocaleV1;
  readonly nextStep: NextStepPresentation;
  readonly opportunityId: string;
}

export type OwnerTaughtPolicyCardPreviewResult =
  | Readonly<{
      readonly assessedPolicy: Readonly<{
        readonly detail: ContinuityDetailLevel;
        readonly nextStep: NextStepPresentation;
      }>;
      readonly card: AttuneGraphPolicyCardV1;
      readonly schemaVersion: 1;
      readonly status: "rendered";
    }>
  | Readonly<{
      readonly reason:
        | "no-op"
        | "replay-not-eligible"
        | "state-drift"
        | AttuneGraphPolicyCardHeldReasonV1;
      readonly schemaVersion: 1;
      readonly status: "held";
    }>
  | Readonly<{
      readonly reason:
        | "invalid-request"
        | "no-opportunity"
        | "state-unavailable"
        | "evaluation-failed";
      readonly schemaVersion: 1;
      readonly status: "unavailable";
    }>;

export interface OwnerTaughtPolicyCardPreviewService {
  preview(
    input: OwnerTaughtPolicyCardPreviewInput
  ): Promise<OwnerTaughtPolicyCardPreviewResult>;
}

export interface CreateOwnerTaughtPolicyCardPreviewServiceOptions {
  readonly now: () => Date;
  readonly policyCardPreview: ContinuityLearningPolicyCardPreviewService;
  readonly readState: () => Promise<AttunementState>;
}

/**
 * Converts one explicit owner display choice into an inert, thread-bounded
 * proposal. The generated replay proves only contract preservation; it does
 * not claim usefulness and grants no approval or write authority.
 */
export function createOwnerTaughtPolicyCardPreviewService(
  options: CreateOwnerTaughtPolicyCardPreviewServiceOptions
): OwnerTaughtPolicyCardPreviewService {
  return Object.freeze({
    async preview(
      input: OwnerTaughtPolicyCardPreviewInput
    ): Promise<OwnerTaughtPolicyCardPreviewResult> {
      try {
        if (!validInput(input)) return unavailable("invalid-request");
      } catch {
        return unavailable("invalid-request");
      }
      let state: AttunementState;
      try {
        state = await options.readState();
      } catch {
        return unavailable("state-unavailable");
      }
      const matches = buildExperienceLearningReviewQueue(state).items.filter(
        (item) => item.opportunityId === input.opportunityId
      );
      if (matches.length !== 1
        || matches[0]!.sourceRun.evidenceClass !== "organic-production") {
        return unavailable("no-opportunity");
      }
      const opportunity = matches[0]!;
      const thread = state.threads.find((item) =>
        item.id === opportunity.scope.threadId
      );
      if (!thread) return unavailable("state-unavailable");
      if (thread.policy.detail === input.detail
        && thread.policy.nextStep === input.nextStep) {
        return held("no-op");
      }

      const proposed = options.now();
      if (!(proposed instanceof Date) || !Number.isFinite(proposed.getTime())) {
        return unavailable("state-unavailable");
      }
      const proposedAt = proposed.toISOString();
      const expiresAt = new Date(
        proposed.getTime() + 7 * 24 * 60 * 60 * 1_000
      ).toISOString();
      const copy = input.locale === "ko"
        ? {
            expectedBenefit:
              "이 thread에 사용자가 명시적으로 선택한 표시 형식만 적용합니다.",
            proposedBehavior:
              `이 thread에서는 ${input.detail} 밀도와 ${input.nextStep} 다음 단계 표시를 사용합니다.`
          }
        : {
            expectedBenefit:
              "Apply only the display format explicitly selected by the owner for this thread.",
            proposedBehavior:
              `Use ${input.detail} detail and ${input.nextStep} next steps for this thread.`
          };
      const draft = Object.freeze({
        expectedBenefit: copy.expectedBenefit,
        expiresAt,
        experienceId: `owner-taught:${input.opportunityId}`,
        proposedAt,
        proposedBehavior: copy.proposedBehavior,
        proposedChange: Object.freeze({
          detail: input.detail,
          kind: "thread-display" as const,
          nextStep: input.nextStep
        }),
        scope: Object.freeze({
          kind: "thread-display" as const,
          threadId: opportunity.scope.threadId
        })
      });
      const heldOutCases = contractCases({
        detail: input.detail,
        nextStep: input.nextStep,
        suppression: thread.policy.suppression,
        threadId: thread.id
      });
      const preparation = createContinuityLearningPreparationService({
        evaluator: {
          evaluate: evaluateContractCase,
          id: "owner-taught-policy-contract",
          version: "1"
        },
        heldOutCases,
        now: options.now,
        readState: options.readState,
        timeoutMs: PREPARATION_TIMEOUT_MS
      });
      const prepared = await preparation.prepare({
        draft,
        opportunityId: input.opportunityId
      });
      if (prepared.status === "unavailable") {
        return unavailable(prepared.reason === "invalid-configuration"
          || prepared.reason === "invalid-request"
          ? "invalid-request"
          : prepared.reason);
      }
      if (prepared.status === "held") return held(prepared.reason);
      const compiled = await options.policyCardPreview.preview({
        draft,
        evidenceCases: prepared.replayBundle.cases,
        locale: input.locale,
        opportunityId: input.opportunityId
      });
      if (compiled.status === "held") return held(compiled.reason);
      let assessedState: AttunementState;
      try {
        assessedState = await options.readState();
      } catch {
        return unavailable("state-unavailable");
      }
      const assessedThreads = assessedState.threads.filter((item) =>
        item.id === compiled.card.scope.threadId
      );
      const assessedThread = assessedThreads.length === 1
        ? assessedThreads[0]
        : undefined;
      if (!assessedThread
        || fingerprintContinuityPolicy(assessedThread.policy)
          !== compiled.card.proposal.activeBehaviorDigestBefore) {
        return held("state-drift");
      }
      return Object.freeze({
        assessedPolicy: Object.freeze({
          detail: assessedThread.policy.detail,
          nextStep: assessedThread.policy.nextStep
        }),
        card: compiled.card,
        schemaVersion: 1 as const,
        status: "rendered" as const
      });
    }
  });
}

function contractCases(input: Readonly<{
  readonly detail: ContinuityDetailLevel;
  readonly nextStep: NextStepPresentation;
  readonly suppression: string;
  readonly threadId: string;
}>) {
  const cases = [
    ["desired-detail", { check: "detail", expected: input.detail }],
    ["desired-next-step", { check: "nextStep", expected: input.nextStep }],
    ["preserve-suppression", { check: "suppression", expected: input.suppression }],
    ["preserve-action-scope", { check: "boundary", expected: "not-expanded" }],
    ["preserve-permission", { check: "boundary", expected: "unchanged" }],
    ["preserve-recipient", { check: "boundary", expected: "unchanged" }],
    ["preserve-retention", { check: "boundary", expected: "unchanged" }],
    ["preserve-source", { check: "boundary", expected: "unchanged" }],
    ["thread-only-scope", { check: "threadId", expected: input.threadId }],
    ["no-activation", { check: "activation", expected: "none" }]
  ] as const;
  return Object.freeze(cases.map(([caseId, value]) => Object.freeze({
    caseId,
    input: JSON.stringify(value)
  })));
}

async function evaluateContractCase(
  input: ContinuityLearningEvaluatorInput
): Promise<boolean> {
  const expected = JSON.parse(input.input) as {
    readonly check: string;
    readonly expected: string;
  };
  switch (expected.check) {
    case "detail": return input.policy.detail === expected.expected;
    case "nextStep": return input.policy.nextStep === expected.expected;
    case "suppression": return input.policy.suppression === expected.expected;
    case "threadId": return input.candidate.scope.threadId === expected.expected;
    case "activation": return input.candidate.activation === expected.expected;
    case "boundary": return input.candidate.activation === "none"
      && input.candidate.scope.kind === "thread-display"
      && input.candidate.proposedChange.kind === "thread-display"
      && Reflect.ownKeys(input.candidate.proposedChange).length === 3;
    default: return false;
  }
}

function validInput(value: unknown): value is OwnerTaughtPolicyCardPreviewInput {
  if (typeof value !== "object" || value === null
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 4 || keys.some((key) => typeof key !== "string"
    || !["detail", "locale", "nextStep", "opportunityId"].includes(key))) {
    return false;
  }
  for (const field of ["detail", "locale", "nextStep", "opportunityId"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return false;
    }
  }
  const input = value as Record<string, unknown>;
  return (input.detail === "compact" || input.detail === "standard")
    && (input.locale === "en" || input.locale === "ko")
    && (input.nextStep === "contextual" || input.nextStep === "direct"
      || input.nextStep === "hidden")
    && typeof input.opportunityId === "string"
    && OPPORTUNITY_ID.test(input.opportunityId);
}

function held(
  reason: Extract<OwnerTaughtPolicyCardPreviewResult, { status: "held" }>["reason"]
): OwnerTaughtPolicyCardPreviewResult {
  return Object.freeze({ reason, schemaVersion: 1 as const, status: "held" as const });
}

function unavailable(
  reason: Extract<OwnerTaughtPolicyCardPreviewResult, { status: "unavailable" }>["reason"]
): OwnerTaughtPolicyCardPreviewResult {
  return Object.freeze({
    reason,
    schemaVersion: 1 as const,
    status: "unavailable" as const
  });
}
