import {
  EXPERIENCE_LEARNING_SCOPES,
  buildExperienceLearningProposalPreview,
  buildExperienceLearningReplayBundle,
  buildExperienceLearningReviewQueue,
  createExperienceReplayEvidenceReceipt,
  fingerprintContinuityPolicy,
  parseExperienceLearningChange,
  proposeExperienceLearningFromDelivery,
  type AttunementState,
  type ExperienceLearningCandidate,
  type ExperienceLearningProposalDraft,
  type ExperienceLearningProposalPreview,
  type ExperienceLearningReplayBundle,
  type ExperienceLearningReviewOpportunity,
  type ExperienceLearningScope
} from "@muse/attunement";
import { sha256Hex } from "@muse/shared";

const CASE_LIMIT = 20;
const CASE_INPUT_LIMIT = 16_000;
const REGISTRY_INPUT_LIMIT = 65_536;
const TEXT_LIMIT = 500;
const ID_LIMIT = 160;
const MAX_TIMEOUT_MS = 30_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface ContinuityLearningHeldOutCase {
  readonly caseId: string;
  readonly input: string;
}

export interface ContinuityLearningEvaluatorInput {
  readonly candidate: ExperienceLearningCandidate;
  readonly caseId: string;
  readonly input: string;
  readonly variant: "baseline" | "challenger";
}

export interface ContinuityLearningEvaluator {
  readonly evaluate: (
    input: ContinuityLearningEvaluatorInput,
    signal: AbortSignal
  ) => Promise<unknown>;
  readonly id: string;
  readonly version: string;
}

export interface CreateContinuityLearningPreparationServiceOptions {
  readonly evaluator: ContinuityLearningEvaluator;
  readonly heldOutCases: unknown;
  readonly now: () => Date;
  readonly readState: () => Promise<AttunementState>;
  readonly timeoutMs: number;
}

export interface ContinuityLearningPreparationRequest {
  readonly draft: ExperienceLearningProposalDraft;
}

interface ReviewOnlyAuthority {
  readonly canApprove: false;
  readonly canPromote: false;
  readonly canRollback: false;
  readonly canWritePolicy: false;
}

interface ControlledProvenance {
  readonly evidenceClass: "controlled";
  readonly evaluator: {
    readonly id: string;
    readonly version: string;
  };
  readonly registryDigest: string;
}

export type ContinuityLearningPreparationResult =
  | Readonly<{
      reason:
        | "invalid-configuration"
        | "invalid-request"
        | "no-opportunity"
        | "state-unavailable"
        | "evaluation-failed";
      schemaVersion: 1;
      status: "unavailable";
    }>
  | Readonly<{
      authority: ReviewOnlyAuthority;
      opportunity: ExperienceLearningReviewOpportunity;
      preview: ExperienceLearningProposalPreview;
      provenance: ControlledProvenance;
      reason: "state-drift";
      schemaVersion: 1;
      status: "held";
    }>
  | Readonly<{
      authority: ReviewOnlyAuthority;
      opportunity: ExperienceLearningReviewOpportunity;
      preview: ExperienceLearningProposalPreview;
      provenance: ControlledProvenance;
      reason: "replay-not-eligible";
      replayBundle: ExperienceLearningReplayBundle;
      schemaVersion: 1;
      status: "held";
    }>
  | Readonly<{
      authority: ReviewOnlyAuthority;
      opportunity: ExperienceLearningReviewOpportunity;
      preview: ExperienceLearningProposalPreview;
      provenance: ControlledProvenance;
      replayBundle: ExperienceLearningReplayBundle;
      schemaVersion: 1;
      status: "prepared";
    }>;

export interface ContinuityLearningPreparationService {
  prepare(
    request: ContinuityLearningPreparationRequest
  ): Promise<ContinuityLearningPreparationResult>;
}

interface ParsedOptions {
  readonly evaluator: ContinuityLearningEvaluator;
  readonly heldOutCases: readonly ContinuityLearningHeldOutCase[];
  readonly now: () => Date;
  readonly readState: () => Promise<AttunementState>;
  readonly registryDigest: string;
  readonly timeoutMs: number;
}

const REVIEW_ONLY_AUTHORITY = Object.freeze({
  canApprove: false as const,
  canPromote: false as const,
  canRollback: false as const,
  canWritePolicy: false as const
});

/**
 * Runs one frozen controlled replay for the oldest current organic learning
 * opportunity. The service owns no approval, write, promotion, or rollback
 * capability; its strongest result is an inert recommendation for review.
 */
export function createContinuityLearningPreparationService(
  options: CreateContinuityLearningPreparationServiceOptions
): ContinuityLearningPreparationService {
  const parsed = parseOptions(options);
  return Object.freeze({
    async prepare(
      request: ContinuityLearningPreparationRequest
    ): Promise<ContinuityLearningPreparationResult> {
      if (!parsed) return unavailable("invalid-configuration");
      const draft = parseRequest(request);
      if (!draft) return unavailable("invalid-request");

      const initial = await readState(parsed.readState);
      if (!initial) return unavailable("state-unavailable");
      const opportunity = buildExperienceLearningReviewQueue(initial).items[0];
      if (!opportunity) return unavailable("no-opportunity");
      const delivery = initial.deliveries.find((entry) =>
        entry.id === opportunity.deliveryId
      );
      const thread = initial.threads.find((entry) =>
        entry.id === opportunity.scope.threadId
      );
      if (!delivery || !thread) return unavailable("state-unavailable");

      const activeBehaviorDigest = fingerprintContinuityPolicy(thread.policy);
      const proposal = proposeExperienceLearningFromDelivery({
        activeBehaviorDigest,
        delivery,
        draft
      });
      if (proposal.status !== "proposed"
        || proposal.candidate.outcome.outcomeId !== opportunity.outcome.outcomeId) {
        return unavailable("invalid-request");
      }
      const preview = buildExperienceLearningProposalPreview(proposal.candidate);
      if (!preview) return unavailable("invalid-request");

      const replayBundle = await evaluateReplay(parsed, proposal.candidate);
      if (!replayBundle) return unavailable("evaluation-failed");

      const current = await readState(parsed.readState);
      if (!current) return unavailable("state-unavailable");
      const currentOpportunity =
        buildExperienceLearningReviewQueue(current).items[0];
      const currentThread = current.threads.find((entry) =>
        entry.id === opportunity.scope.threadId
      );
      const provenance = controlledProvenance(parsed);
      if (currentOpportunity?.opportunityId !== opportunity.opportunityId
        || !currentThread
        || fingerprintContinuityPolicy(currentThread.policy)
          !== activeBehaviorDigest) {
        return Object.freeze({
          authority: REVIEW_ONLY_AUTHORITY,
          opportunity,
          preview,
          provenance,
          reason: "state-drift" as const,
          schemaVersion: 1 as const,
          status: "held" as const
        });
      }
      if (replayBundle.replay.recommendation !== "eligible-for-review") {
        return Object.freeze({
          authority: REVIEW_ONLY_AUTHORITY,
          opportunity,
          preview,
          provenance,
          reason: "replay-not-eligible" as const,
          replayBundle,
          schemaVersion: 1 as const,
          status: "held" as const
        });
      }
      return Object.freeze({
        authority: REVIEW_ONLY_AUTHORITY,
        opportunity,
        preview,
        provenance,
        replayBundle,
        schemaVersion: 1 as const,
        status: "prepared" as const
      });
    }
  });
}

async function evaluateReplay(
  options: ParsedOptions,
  candidate: ExperienceLearningCandidate
): Promise<ExperienceLearningReplayBundle | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, options.timeoutMs);
  });
  const evaluated = runEvaluations(options, candidate, controller.signal)
    .catch(() => undefined);
  const result = await Promise.race([evaluated, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function runEvaluations(
  options: ParsedOptions,
  candidate: ExperienceLearningCandidate,
  signal: AbortSignal
): Promise<ExperienceLearningReplayBundle | undefined> {
  const observed = options.now();
  if (!(observed instanceof Date)
    || !Number.isFinite(observed.getTime())) return undefined;
  const observedAt = observed.toISOString();
  const evidenceCases = [];
  for (const heldOutCase of options.heldOutCases) {
    const inputHash = sha256Hex(JSON.stringify({
      caseId: heldOutCase.caseId,
      input: heldOutCase.input
    }));
    const baseline = await options.evaluator.evaluate(
      Object.freeze({
        candidate,
        caseId: heldOutCase.caseId,
        input: heldOutCase.input,
        variant: "baseline" as const
      }),
      signal
    );
    if (typeof baseline !== "boolean" || signal.aborted) return undefined;
    const challenger = await options.evaluator.evaluate(
      Object.freeze({
        candidate,
        caseId: heldOutCase.caseId,
        input: heldOutCase.input,
        variant: "challenger" as const
      }),
      signal
    );
    if (typeof challenger !== "boolean" || signal.aborted) return undefined;
    const baselineReceipt = createExperienceReplayEvidenceReceipt({
      caseId: heldOutCase.caseId,
      evaluator: {
        id: options.evaluator.id,
        version: options.evaluator.version
      },
      inputHash,
      observedAt,
      passed: baseline,
      variant: "baseline"
    });
    const challengerReceipt = createExperienceReplayEvidenceReceipt({
      caseId: heldOutCase.caseId,
      evaluator: {
        id: options.evaluator.id,
        version: options.evaluator.version
      },
      inputHash,
      observedAt,
      passed: challenger,
      variant: "challenger"
    });
    if (!baselineReceipt || !challengerReceipt) return undefined;
    evidenceCases.push(Object.freeze({
      baseline: baselineReceipt,
      caseId: heldOutCase.caseId,
      challenger: challengerReceipt
    }));
  }
  return buildExperienceLearningReplayBundle(candidate, evidenceCases);
}

function parseOptions(
  value: unknown
): ParsedOptions | undefined {
  try {
    const options = exactRecord(value, [
      "evaluator",
      "heldOutCases",
      "now",
      "readState",
      "timeoutMs"
    ]);
    if (!options
      || typeof options.now !== "function"
      || typeof options.readState !== "function"
      || !Number.isInteger(options.timeoutMs)
      || (options.timeoutMs as number) < 1
      || (options.timeoutMs as number) > MAX_TIMEOUT_MS) {
      return undefined;
    }
    const evaluator = exactRecord(options.evaluator, [
      "evaluate",
      "id",
      "version"
    ]);
    if (!evaluator
      || typeof evaluator.evaluate !== "function"
      || typeof evaluator.id !== "string"
      || !SAFE_ID.test(evaluator.id)
      || typeof evaluator.version !== "string"
      || evaluator.version.length === 0
      || evaluator.version.length > 64) {
      return undefined;
    }
    const heldOutCases = parseRegistry(options.heldOutCases);
    if (!heldOutCases) return undefined;
    return Object.freeze({
      evaluator: Object.freeze({
        evaluate: evaluator.evaluate as ContinuityLearningEvaluator["evaluate"],
        id: evaluator.id,
        version: evaluator.version
      }),
      heldOutCases,
      now: options.now as () => Date,
      readState: options.readState as () => Promise<AttunementState>,
      registryDigest: sha256Hex(JSON.stringify(heldOutCases)),
      timeoutMs: options.timeoutMs as number
    });
  } catch {
    return undefined;
  }
}

function parseRegistry(
  value: unknown
): readonly ContinuityLearningHeldOutCase[] | undefined {
  if (!denseDataArray(value)
    || value.length === 0
    || value.length > CASE_LIMIT) return undefined;
  const seen = new Set<string>();
  const parsed: ContinuityLearningHeldOutCase[] = [];
  let totalInput = 0;
  for (const entry of value) {
    const record = exactRecord(entry, ["caseId", "input"]);
    if (!record
      || typeof record.caseId !== "string"
      || !SAFE_ID.test(record.caseId)
      || seen.has(record.caseId)
      || typeof record.input !== "string"
      || record.input.length === 0
      || record.input.length > CASE_INPUT_LIMIT) {
      return undefined;
    }
    totalInput += record.input.length;
    if (totalInput > REGISTRY_INPUT_LIMIT) return undefined;
    seen.add(record.caseId);
    parsed.push(Object.freeze({
      caseId: record.caseId,
      input: record.input
    }));
  }
  parsed.sort((left, right) => left.caseId.localeCompare(right.caseId));
  return Object.freeze(parsed);
}

function parseRequest(
  value: unknown
): ExperienceLearningProposalDraft | undefined {
  try {
    const request = exactRecord(value, ["draft"]);
    const draft = request
      ? exactRecord(request.draft, [
          "expectedBenefit",
          "expiresAt",
          "experienceId",
          "proposedAt",
          "proposedBehavior",
          "proposedChange",
          "scope"
        ])
      : undefined;
    if (!draft
      || !boundedText(draft.expectedBenefit, TEXT_LIMIT)
      || !boundedText(draft.experienceId, ID_LIMIT)
      || !boundedText(draft.proposedBehavior, TEXT_LIMIT)
      || typeof draft.proposedAt !== "string"
      || typeof draft.expiresAt !== "string") {
      return undefined;
    }
    const scope = exactRecord(draft.scope, ["kind", "threadId"]);
    if (!scope
      || typeof scope.kind !== "string"
      || !EXPERIENCE_LEARNING_SCOPES.includes(
        scope.kind as ExperienceLearningScope
      )
      || !boundedText(scope.threadId, ID_LIMIT)) {
      return undefined;
    }
    const proposedChange = parseExperienceLearningChange(
      draft.proposedChange,
      scope.kind as ExperienceLearningScope
    );
    if (!proposedChange) return undefined;
    return Object.freeze({
      expectedBenefit: draft.expectedBenefit,
      expiresAt: draft.expiresAt,
      experienceId: draft.experienceId,
      proposedAt: draft.proposedAt,
      proposedBehavior: draft.proposedBehavior,
      proposedChange,
      scope: Object.freeze({
        kind: scope.kind as ExperienceLearningScope,
        threadId: scope.threadId
      })
    });
  } catch {
    return undefined;
  }
}

async function readState(
  reader: () => Promise<AttunementState>
): Promise<AttunementState | undefined> {
  try {
    return await reader();
  } catch {
    return undefined;
  }
}

function controlledProvenance(
  options: ParsedOptions
): ControlledProvenance {
  return Object.freeze({
    evidenceClass: "controlled" as const,
    evaluator: Object.freeze({
      id: options.evaluator.id,
      version: options.evaluator.version
    }),
    registryDigest: options.registryDigest
  });
}

function unavailable(
  reason: Extract<
    ContinuityLearningPreparationResult,
    { status: "unavailable" }
  >["reason"]
): ContinuityLearningPreparationResult {
  return Object.freeze({
    reason,
    schemaVersion: 1 as const,
    status: "unavailable" as const
  });
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= max;
}

function exactRecord(
  value: unknown,
  fields: readonly string[]
): Record<string, unknown> | undefined {
  if (typeof value !== "object"
    || value === null
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length
    || keys.some((key) =>
      typeof key !== "string" || !fields.includes(key))) return undefined;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.get !== undefined
      || descriptor.set !== undefined
      || descriptor.enumerable !== true) return undefined;
  }
  return value as Record<string, unknown>;
}

function denseDataArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const expected = [
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
    "length"
  ];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
    || keys.some((key) =>
      typeof key !== "string" || !expected.includes(key))) return false;
  return expected.slice(0, -1).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && Object.hasOwn(descriptor, "value")
      && descriptor.get === undefined
      && descriptor.set === undefined
      && descriptor.enumerable === true;
  });
}
