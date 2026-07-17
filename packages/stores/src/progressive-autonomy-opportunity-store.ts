import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  ProgressiveAutonomyActionEnvelope,
  ProgressiveAutonomyEnforcementDecision,
  ProgressiveAutonomyShadowAssessment
} from "@muse/policy";

import { atomicWriteFile, withFileMutationQueue } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";

export interface ProgressiveAutonomyRuntimeOpportunityReceipt {
  readonly evidenceClass: ProgressiveAutonomyOpportunityEvidenceClass;
  readonly enforcementDecision: ProgressiveAutonomyEnforcementDecision;
  readonly envelope: ProgressiveAutonomyActionEnvelope;
  readonly id: string;
  readonly matchedGrantId?: string;
  readonly origin: "runtime-opportunity";
  readonly rationale: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly shadowAssessment: ProgressiveAutonomyShadowAssessment;
  readonly shadowRationale: string;
  readonly toolCallId: string;
}

export type ProgressiveAutonomyOpportunityEvidenceClass = "controlled" | "organic" | "unclassified";

export type ProgressiveAutonomyOpportunityReviewDecision =
  | "needs-adjustment"
  | "would-approve"
  | "would-deny";

export type ProgressiveAutonomyOpportunitySourceState = "exact" | "stale";

export interface ProgressiveAutonomyOpportunityReviewReceipt {
  readonly action: ProgressiveAutonomyActionEnvelope["action"];
  readonly decision: ProgressiveAutonomyOpportunityReviewDecision;
  readonly evidenceClass: "organic";
  readonly id: string;
  readonly linkedAt: string;
  readonly opportunityId: string;
  readonly ownerUserId: string;
  readonly reason?: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly sourceReason?: string;
  readonly sourceState: ProgressiveAutonomyOpportunitySourceState;
  readonly taskId: string;
  readonly threadId: string;
  readonly toolCallId: string;
}

export type ProgressiveAutonomyRuntimeDecision = "approved" | "denied";

export interface ProgressiveAutonomyRuntimeDecisionInput {
  readonly decision: ProgressiveAutonomyRuntimeDecision;
  readonly ownerUserId: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly toolCallId: string;
}

export interface ProgressiveAutonomyRuntimeDecisionReceipt {
  readonly action: ProgressiveAutonomyActionEnvelope["action"];
  readonly decision: ProgressiveAutonomyRuntimeDecision;
  readonly linkedAt: string;
  readonly opportunityId: string;
  readonly origin: "runtime-tool-approval";
  readonly ownerUserId: string;
  readonly provenance: "explicit-cli-ink";
  readonly recordedAt: string;
  readonly runId: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly toolName: "muse.tasks.complete";
}

export type ProgressiveAutonomyRuntimeDecisionRecordResult =
  | { readonly kind: "not-correlated" }
  | { readonly kind: "recorded"; readonly receipt: ProgressiveAutonomyRuntimeDecisionReceipt };

interface OpportunityTrace {
  readonly envelope: ProgressiveAutonomyActionEnvelope;
  readonly runId: string;
  readonly toolCallId: string;
}

interface OpportunityState {
  readonly opportunities: readonly ProgressiveAutonomyRuntimeOpportunityReceipt[];
  readonly reviews: readonly ProgressiveAutonomyOpportunityReviewReceipt[];
  readonly runtimeDecisions: readonly ProgressiveAutonomyRuntimeDecisionReceipt[];
  readonly schemaVersion: 3;
  readonly traces: readonly OpportunityTrace[];
}

export class ProgressiveAutonomyOpportunityStoreCorruptError extends Error {
  constructor() {
    super("progressive autonomy opportunity store is corrupt; refusing evidence");
    this.name = "ProgressiveAutonomyOpportunityStoreCorruptError";
  }
}

export class ProgressiveAutonomyOpportunityReviewConflictError extends Error {
  constructor() {
    super("progressive autonomy opportunity already has a different review");
    this.name = "ProgressiveAutonomyOpportunityReviewConflictError";
  }
}

export class ProgressiveAutonomyRuntimeDecisionConflictError extends Error {
  constructor() {
    super("progressive autonomy opportunity already has different explicit evidence");
    this.name = "ProgressiveAutonomyRuntimeDecisionConflictError";
  }
}

export class FileProgressiveAutonomyOpportunityStore {
  private readonly file: string;

  constructor(options: { readonly file: string }) {
    if (options.file.trim().length === 0) throw new TypeError("opportunity store file must not be blank");
    this.file = options.file;
  }

  async list(): Promise<readonly ProgressiveAutonomyRuntimeOpportunityReceipt[]> {
    return structuredClone((await this.read()).opportunities);
  }

  async listReviews(): Promise<readonly ProgressiveAutonomyOpportunityReviewReceipt[]> {
    return structuredClone((await this.read()).reviews);
  }

  async listRuntimeDecisions(): Promise<readonly ProgressiveAutonomyRuntimeDecisionReceipt[]> {
    return structuredClone((await this.read()).runtimeDecisions);
  }

  async recordRuntimeDecision(
    candidate: ProgressiveAutonomyRuntimeDecisionInput
  ): Promise<ProgressiveAutonomyRuntimeDecisionRecordResult> {
    const input = parseRuntimeDecisionInput(structuredClone(candidate));
    await fs.mkdir(dirname(this.file), { recursive: true });
    return withFileMutationQueue(this.file, () => withFileLock(this.file, async () => {
      const state = await this.read();
      const opportunity = state.opportunities.find((entry) => entry.evidenceClass === "organic"
        && entry.runId === input.runId
        && entry.toolCallId === input.toolCallId
        && entry.envelope.userId === input.ownerUserId);
      if (!opportunity) return { kind: "not-correlated" };
      const receipt: ProgressiveAutonomyRuntimeDecisionReceipt = {
        action: opportunity.envelope.action,
        decision: input.decision,
        linkedAt: opportunity.envelope.link.linkedAt,
        opportunityId: opportunity.id,
        origin: "runtime-tool-approval",
        ownerUserId: opportunity.envelope.userId,
        provenance: "explicit-cli-ink",
        recordedAt: input.recordedAt,
        runId: opportunity.runId,
        taskId: opportunity.envelope.link.taskId,
        threadId: opportunity.envelope.threadId,
        toolCallId: opportunity.toolCallId,
        toolName: "muse.tasks.complete"
      };
      assertRuntimeDecisionBinding(receipt, opportunity);
      if (state.reviews.some((entry) => entry.opportunityId === opportunity.id)) {
        throw new ProgressiveAutonomyRuntimeDecisionConflictError();
      }
      const existing = state.runtimeDecisions.find((entry) => entry.opportunityId === opportunity.id);
      if (existing) {
        if (existing.decision === receipt.decision) return { kind: "recorded", receipt: structuredClone(existing) };
        throw new ProgressiveAutonomyRuntimeDecisionConflictError();
      }
      const next: OpportunityState = {
        ...state,
        runtimeDecisions: [...state.runtimeDecisions, receipt],
        schemaVersion: 3
      };
      const validated = parseState(next);
      await atomicWriteFile(this.file, `${JSON.stringify(validated, null, 2)}\n`);
      await fs.chmod(this.file, 0o600);
      return { kind: "recorded", receipt: structuredClone(receipt) };
    }));
  }

  async recordReview(
    candidate: ProgressiveAutonomyOpportunityReviewReceipt
  ): Promise<ProgressiveAutonomyOpportunityReviewReceipt> {
    const review = parseReview(structuredClone(candidate), true);
    await fs.mkdir(dirname(this.file), { recursive: true });
    return withFileMutationQueue(this.file, () => withFileLock(this.file, async () => {
      const state = await this.read();
      const opportunity = state.opportunities.find((entry) => entry.id === review.opportunityId);
      if (!opportunity) throw new TypeError("progressive autonomy opportunity does not exist");
      if (opportunity.evidenceClass !== "organic") {
        throw new TypeError("only organic opportunities can be reviewed");
      }
      assertReviewBinding(review, opportunity);
      if (state.runtimeDecisions.some((entry) => entry.opportunityId === review.opportunityId)) {
        throw new ProgressiveAutonomyOpportunityReviewConflictError();
      }
      const existing = state.reviews.find((entry) => entry.opportunityId === review.opportunityId);
      if (existing) {
        if (sameCanonicalReview(existing, review)) return structuredClone(existing);
        throw new ProgressiveAutonomyOpportunityReviewConflictError();
      }
      const next: OpportunityState = {
        ...state,
        reviews: [...state.reviews, review],
        schemaVersion: 3
      };
      const validated = parseState(next);
      await atomicWriteFile(this.file, `${JSON.stringify(validated, null, 2)}\n`);
      await fs.chmod(this.file, 0o600);
      return structuredClone(review);
    }));
  }

  async record(
    candidate: ProgressiveAutonomyRuntimeOpportunityReceipt
  ): Promise<ProgressiveAutonomyRuntimeOpportunityReceipt> {
    const receipt = parseReceipt(structuredClone(candidate));
    await fs.mkdir(dirname(this.file), { recursive: true });
    return withFileMutationQueue(this.file, () => withFileLock(this.file, async () => {
      const state = await this.read();
      const sameTrace = state.traces.find((entry) =>
        entry.runId === receipt.runId && entry.toolCallId === receipt.toolCallId
      );
      if (sameTrace) {
        if (!isDeepStrictEqual(sameTrace.envelope, receipt.envelope)) {
          throw new TypeError("runtime opportunity trace cannot be replayed with different scope");
        }
        const existing = state.opportunities.find((entry) => sameLogicalOpportunity(entry, receipt));
        if (!existing) throw new ProgressiveAutonomyOpportunityStoreCorruptError();
        return structuredClone(existing); // exact replay: no write
      }

      const existing = state.opportunities.find((entry) => sameLogicalOpportunity(entry, receipt));
      const next: OpportunityState = {
        opportunities: existing ? state.opportunities : [...state.opportunities, receipt],
        reviews: state.reviews,
        runtimeDecisions: state.runtimeDecisions,
        schemaVersion: 3,
        traces: [...state.traces, {
          envelope: receipt.envelope,
          runId: receipt.runId,
          toolCallId: receipt.toolCallId
        }]
      };
      const validated = parseState(next); // validate the full candidate before write
      await atomicWriteFile(this.file, `${JSON.stringify(validated, null, 2)}\n`);
      await fs.chmod(this.file, 0o600);
      return structuredClone(existing ?? receipt);
    }));
  }

  private async read(): Promise<OpportunityState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    try {
      return parseState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof ProgressiveAutonomyOpportunityStoreCorruptError) throw error;
      throw new ProgressiveAutonomyOpportunityStoreCorruptError();
    }
  }
}

function emptyState(): OpportunityState {
  return { opportunities: [], reviews: [], runtimeDecisions: [], schemaVersion: 3, traces: [] };
}

function parseState(value: unknown): OpportunityState {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3)
    || !Array.isArray(value.opportunities)
    || !Array.isArray(value.traces)) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  const schemaVersion = value.schemaVersion as 1 | 2 | 3;
  if (!isExactRecord(value, schemaVersion === 1
    ? ["opportunities", "schemaVersion", "traces"]
    : schemaVersion === 2
      ? ["opportunities", "reviews", "schemaVersion", "traces"]
      : ["opportunities", "reviews", "runtimeDecisions", "schemaVersion", "traces"])
    || (schemaVersion >= 2 && !Array.isArray(value.reviews))
    || (schemaVersion === 3 && !Array.isArray(value.runtimeDecisions))) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  const opportunities = value.opportunities.map((entry) => parseReceipt(entry, schemaVersion));
  const traces = value.traces.map(parseTrace);
  const reviews = schemaVersion === 1 ? [] : (value.reviews as unknown[]).map((entry) => parseReview(entry, false));
  const runtimeDecisions = schemaVersion === 3
    ? (value.runtimeDecisions as unknown[]).map(parseRuntimeDecisionReceipt)
    : [];
  if (new Set(traces.map((entry) => traceKey(entry))).size !== traces.length
    || new Set(opportunities.map((entry) => logicalKey(entry))).size !== opportunities.length
    || new Set(opportunities.map((entry) => entry.id)).size !== opportunities.length
    || opportunities.some((opportunity) => !traces.some((trace) => sameSemanticScope(opportunity, trace)))
    || opportunities.some((opportunity) => traces.filter((trace) =>
      trace.runId === opportunity.runId
      && trace.toolCallId === opportunity.toolCallId
      && sameSemanticScope(opportunity, trace)
    ).length !== 1)
    || traces.some((trace) => opportunities.filter((entry) => sameSemanticScope(entry, trace)).length !== 1)
    || new Set(reviews.map((entry) => entry.id)).size !== reviews.length
    || new Set(reviews.map((entry) => entry.opportunityId)).size !== reviews.length
    || new Set(runtimeDecisions.map((entry) => entry.opportunityId)).size !== runtimeDecisions.length
    || runtimeDecisions.some((decision) => reviews.some((review) => review.opportunityId === decision.opportunityId))) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  for (const review of reviews) {
    const opportunity = opportunities.find((entry) => entry.id === review.opportunityId);
    if (!opportunity || opportunity.evidenceClass !== "organic") {
      throw new ProgressiveAutonomyOpportunityStoreCorruptError();
    }
    try {
      assertReviewBinding(review, opportunity);
    } catch {
      throw new ProgressiveAutonomyOpportunityStoreCorruptError();
    }
  }
  for (const decision of runtimeDecisions) {
    const opportunity = opportunities.find((entry) => entry.id === decision.opportunityId);
    if (!opportunity || opportunity.evidenceClass !== "organic") {
      throw new ProgressiveAutonomyOpportunityStoreCorruptError();
    }
    try {
      assertRuntimeDecisionBinding(decision, opportunity);
    } catch {
      throw new ProgressiveAutonomyOpportunityStoreCorruptError();
    }
  }
  return { opportunities, reviews, runtimeDecisions, schemaVersion: 3, traces };
}

function parseReview(value: unknown, normalize: boolean): ProgressiveAutonomyOpportunityReviewReceipt {
  const optionalKeys = ["reason", "sourceReason"].filter((key) => isRecord(value) && key in value);
  const keys = [
    "action", "decision", "evidenceClass", "id", "linkedAt", "opportunityId", "ownerUserId",
    "recordedAt", "runId", "sourceState", "taskId", "threadId", "toolCallId", ...optionalKeys
  ];
  if (!isExactRecord(value, keys)
    || value.action !== "muse.tasks.complete-linked-next-step"
    || !oneOf(value.decision, ["needs-adjustment", "would-approve", "would-deny"])
    || value.evidenceClass !== "organic"
    || !isNonBlank(value.id) || !isCanonicalUtcIso(value.linkedAt) || !isNonBlank(value.opportunityId)
    || !isNonBlank(value.ownerUserId) || !isCanonicalUtcIso(value.recordedAt) || !isNonBlank(value.runId)
    || !oneOf(value.sourceState, ["exact", "stale"])
    || !isNonBlank(value.taskId) || !isNonBlank(value.threadId) || !isNonBlank(value.toolCallId)) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  const reason = normalizeOptionalText(value.reason, normalize);
  const sourceReason = normalizeOptionalText(value.sourceReason, normalize);
  if ((!normalize && ("reason" in value) !== (reason !== undefined))
    || (!normalize && ("sourceReason" in value) !== (sourceReason !== undefined))
    || (value.decision === "would-approve" && value.sourceState !== "exact")
    || (value.sourceState === "exact" && sourceReason !== undefined)
    || (value.sourceState === "stale" && sourceReason === undefined)) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  const { reason: _reason, sourceReason: _sourceReason, ...required } = value;
  return {
    ...(required as unknown as ProgressiveAutonomyOpportunityReviewReceipt),
    ...(reason === undefined ? {} : { reason }),
    ...(sourceReason === undefined ? {} : { sourceReason })
  };
}

function parseRuntimeDecisionInput(value: unknown): ProgressiveAutonomyRuntimeDecisionInput {
  if (!isExactRecord(value, ["decision", "ownerUserId", "recordedAt", "runId", "toolCallId"])
    || !oneOf(value.decision, ["approved", "denied"])
    || !isNonBlank(value.ownerUserId)
    || !isCanonicalUtcIso(value.recordedAt)
    || !isNonBlank(value.runId)
    || !isNonBlank(value.toolCallId)) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  return value as unknown as ProgressiveAutonomyRuntimeDecisionInput;
}

function parseRuntimeDecisionReceipt(value: unknown): ProgressiveAutonomyRuntimeDecisionReceipt {
  if (!isExactRecord(value, [
    "action", "decision", "linkedAt", "opportunityId", "origin", "ownerUserId", "provenance",
    "recordedAt", "runId", "taskId", "threadId", "toolCallId", "toolName"
  ])
    || value.action !== "muse.tasks.complete-linked-next-step"
    || !oneOf(value.decision, ["approved", "denied"])
    || !isCanonicalUtcIso(value.linkedAt)
    || !isNonBlank(value.opportunityId)
    || value.origin !== "runtime-tool-approval"
    || !isNonBlank(value.ownerUserId)
    || value.provenance !== "explicit-cli-ink"
    || !isCanonicalUtcIso(value.recordedAt)
    || !isNonBlank(value.runId)
    || !isNonBlank(value.taskId)
    || !isNonBlank(value.threadId)
    || !isNonBlank(value.toolCallId)
    || value.toolName !== "muse.tasks.complete") {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  return value as unknown as ProgressiveAutonomyRuntimeDecisionReceipt;
}

function normalizeOptionalText(value: unknown, normalize: boolean): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  const result = normalize ? value.trim() : value;
  if (normalize && result.length === 0) return undefined;
  if (result.length === 0 || result.length > 500 || /[\u0000-\u001f\u007f]/u.test(result)
    || (!normalize && result !== result.trim())) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  return result;
}

function assertReviewBinding(
  review: ProgressiveAutonomyOpportunityReviewReceipt,
  opportunity: ProgressiveAutonomyRuntimeOpportunityReceipt
): void {
  if (review.ownerUserId !== opportunity.envelope.userId
    || review.runId !== opportunity.runId
    || review.toolCallId !== opportunity.toolCallId
    || review.action !== opportunity.envelope.action
    || review.taskId !== opportunity.envelope.link.taskId
    || review.threadId !== opportunity.envelope.threadId
    || review.linkedAt !== opportunity.envelope.link.linkedAt
    || review.evidenceClass !== opportunity.evidenceClass
    || Date.parse(review.recordedAt) < Date.parse(opportunity.recordedAt)) {
    throw new TypeError("progressive autonomy review does not match its opportunity");
  }
}

function assertRuntimeDecisionBinding(
  decision: ProgressiveAutonomyRuntimeDecisionReceipt,
  opportunity: ProgressiveAutonomyRuntimeOpportunityReceipt
): void {
  if (decision.opportunityId !== opportunity.id
    || decision.ownerUserId !== opportunity.envelope.userId
    || decision.runId !== opportunity.runId
    || decision.toolCallId !== opportunity.toolCallId
    || decision.action !== opportunity.envelope.action
    || decision.taskId !== opportunity.envelope.link.taskId
    || decision.threadId !== opportunity.envelope.threadId
    || decision.linkedAt !== opportunity.envelope.link.linkedAt
    || decision.toolName !== "muse.tasks.complete"
    || Date.parse(decision.recordedAt) < Date.parse(opportunity.recordedAt)) {
    throw new TypeError("progressive autonomy runtime decision does not match its opportunity");
  }
}

function sameCanonicalReview(
  left: ProgressiveAutonomyOpportunityReviewReceipt,
  right: ProgressiveAutonomyOpportunityReviewReceipt
): boolean {
  return left.ownerUserId === right.ownerUserId
    && left.opportunityId === right.opportunityId
    && left.decision === right.decision
    && left.reason === right.reason
    && left.sourceState === right.sourceState
    && left.sourceReason === right.sourceReason;
}

function parseReceipt(value: unknown, schemaVersion: 1 | 2 | 3 = 3): ProgressiveAutonomyRuntimeOpportunityReceipt {
  const keys = [
    "enforcementDecision", "envelope", "id", "origin", "rationale", "recordedAt",
    "runId", "shadowAssessment", "shadowRationale", "toolCallId"
  ];
  if (schemaVersion >= 2) keys.push("evidenceClass");
  if (isRecord(value) && "matchedGrantId" in value) keys.push("matchedGrantId");
  if (!isExactRecord(value, keys)
    || value.origin !== "runtime-opportunity"
    || !oneOf(value.enforcementDecision, ["deny", "confirm", "allow-standing"])
    || !oneOf(value.shadowAssessment, ["wouldDeny", "wouldConfirm", "wouldAllowStanding"])
    || (schemaVersion >= 2 && !oneOf(value.evidenceClass, ["controlled", "organic", "unclassified"]))
    || !isNonBlank(value.id) || !isNonBlank(value.rationale) || !isIso(value.recordedAt)
    || !isNonBlank(value.runId) || !isNonBlank(value.shadowRationale) || !isNonBlank(value.toolCallId)
    || ("matchedGrantId" in value && !isNonBlank(value.matchedGrantId))
    || !isEnvelope(value.envelope)
    || !isValidShadowDecision(value)) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  const receipt = (schemaVersion === 1
    ? { ...value, evidenceClass: "unclassified" }
    : value) as unknown as ProgressiveAutonomyRuntimeOpportunityReceipt;
  if (!hasCanonicalRuntimeBinding(receipt)) throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  return receipt;
}

function isValidShadowDecision(value: Record<string, unknown>): boolean {
  const hasMatchedGrant = "matchedGrantId" in value;
  if (value.shadowAssessment === "wouldAllowStanding") {
    return value.enforcementDecision === "confirm" && hasMatchedGrant;
  }
  if (value.shadowAssessment === "wouldConfirm") {
    return value.enforcementDecision === "confirm" && !hasMatchedGrant;
  }
  return value.shadowAssessment === "wouldDeny"
    && value.enforcementDecision === "deny"
    && !hasMatchedGrant;
}

function parseTrace(value: unknown): OpportunityTrace {
  if (!isExactRecord(value, ["envelope", "runId", "toolCallId"])
    || !isNonBlank(value.runId) || !isNonBlank(value.toolCallId) || !isEnvelope(value.envelope)) {
    throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  }
  const trace = value as unknown as OpportunityTrace;
  if (!hasCanonicalRuntimeBinding(trace)) throw new ProgressiveAutonomyOpportunityStoreCorruptError();
  return trace;
}

function hasCanonicalRuntimeBinding(
  value: Pick<ProgressiveAutonomyRuntimeOpportunityReceipt, "envelope" | "runId" | "toolCallId">
): boolean {
  return value.envelope.traceId === `runtime-tool:${value.runId}:${value.toolCallId}`
    && value.envelope.idempotencyKey
      === `runtime-opportunity:${value.runId}:${value.envelope.link.taskId}`;
}

function isEnvelope(value: unknown): value is ProgressiveAutonomyActionEnvelope {
  return isExactRecord(value, ["action", "idempotencyKey", "link", "schemaVersion", "threadId", "traceId", "transition", "userId"])
    && value.action === "muse.tasks.complete-linked-next-step"
    && value.schemaVersion === 1
    && isNonBlank(value.idempotencyKey) && isNonBlank(value.threadId) && isNonBlank(value.traceId) && isNonBlank(value.userId)
    && isExactRecord(value.link, ["artifactType", "linkedAt", "providerId", "role", "taskId"])
    && value.link.artifactType === "task" && value.link.providerId === "local" && value.link.role === "next-step"
    && isIso(value.link.linkedAt) && isNonBlank(value.link.taskId)
    && isExactRecord(value.transition, ["from", "to"])
    && value.transition.from === "open" && value.transition.to === "done";
}

function sameLogicalOpportunity(
  left: Pick<ProgressiveAutonomyRuntimeOpportunityReceipt, "envelope" | "runId">,
  right: Pick<ProgressiveAutonomyRuntimeOpportunityReceipt, "envelope" | "runId"> | OpportunityTrace
): boolean {
  return left.runId === right.runId
    && left.envelope.action === right.envelope.action
    && left.envelope.link.taskId === right.envelope.link.taskId;
}

function sameSemanticScope(
  opportunity: Pick<ProgressiveAutonomyRuntimeOpportunityReceipt, "envelope" | "runId">,
  trace: OpportunityTrace
): boolean {
  const left = opportunity.envelope;
  const right = trace.envelope;
  return opportunity.runId === trace.runId
    && left.action === right.action
    && left.schemaVersion === right.schemaVersion
    && left.idempotencyKey === right.idempotencyKey
    && left.threadId === right.threadId
    && left.userId === right.userId
    && left.link.artifactType === right.link.artifactType
    && left.link.linkedAt === right.link.linkedAt
    && left.link.providerId === right.link.providerId
    && left.link.role === right.link.role
    && left.link.taskId === right.link.taskId
    && left.transition.from === right.transition.from
    && left.transition.to === right.transition.to;
}

function logicalKey(value: Pick<ProgressiveAutonomyRuntimeOpportunityReceipt, "envelope" | "runId">): string {
  return `${value.runId}\u0000${value.envelope.action}\u0000${value.envelope.link.taskId}`;
}

function traceKey(value: OpportunityTrace): string {
  return `${value.runId}\u0000${value.toolCallId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIso(value: unknown): value is string {
  return isNonBlank(value) && Number.isFinite(Date.parse(value));
}

function isCanonicalUtcIso(value: unknown): value is string {
  if (!isIso(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
