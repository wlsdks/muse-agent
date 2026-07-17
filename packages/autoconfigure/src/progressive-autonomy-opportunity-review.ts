import { createHash } from "node:crypto";

import { readAttunementState } from "@muse/attunement";
import { readTaskByIdStrict } from "@muse/stores";
import {
  FileProgressiveAutonomyOpportunityStore,
  type ProgressiveAutonomyOpportunityReviewDecision,
  type ProgressiveAutonomyOpportunityReviewReceipt,
  type ProgressiveAutonomyRuntimeOpportunityReceipt
} from "@muse/stores/host-progressive-autonomy-opportunities";

export type ProgressiveAutonomyCurrentSource =
  | { readonly state: "exact" }
  | { readonly reason: string; readonly state: "stale" | "unavailable" };

export interface ProgressiveAutonomyOpportunityReviewPresentation {
  readonly action: ProgressiveAutonomyRuntimeOpportunityReceipt["envelope"]["action"];
  readonly currentSource: ProgressiveAutonomyCurrentSource;
  readonly evidenceClass: "organic";
  readonly linkedAt: string;
  readonly opportunityId: string;
  readonly ownerUserId: string;
  readonly recordedAt: string;
  readonly runId: string;
  readonly shadowAssessment: ProgressiveAutonomyRuntimeOpportunityReceipt["shadowAssessment"];
  readonly shadowRationale: string;
  readonly taskId: string;
  readonly threadId: string;
  readonly toolCallId: string;
}

export interface ProgressiveAutonomyOpportunityReviewServiceOptions {
  readonly attunementFile: string;
  readonly now?: () => Date;
  readonly opportunitiesFile: string;
  readonly ownerUserId: string;
  readonly tasksFile: string;
}

export class ProgressiveAutonomyOpportunityReviewService {
  private readonly now: () => Date;
  private readonly options: ProgressiveAutonomyOpportunityReviewServiceOptions;
  private readonly store: FileProgressiveAutonomyOpportunityStore;

  constructor(options: ProgressiveAutonomyOpportunityReviewServiceOptions) {
    if (options.ownerUserId.trim().length === 0) throw new TypeError("owner user id must not be blank");
    this.options = { ...options, ownerUserId: options.ownerUserId.trim() };
    this.now = options.now ?? (() => new Date());
    this.store = new FileProgressiveAutonomyOpportunityStore({ file: options.opportunitiesFile });
  }

  async review(): Promise<ProgressiveAutonomyOpportunityReviewPresentation | undefined> {
    const [opportunities, reviews] = await Promise.all([this.store.list(), this.store.listReviews()]);
    const reviewed = new Set(reviews.map((entry) => entry.opportunityId));
    const opportunity = opportunities
      .filter((entry) => entry.evidenceClass === "organic"
        && entry.envelope.userId === this.options.ownerUserId
        && !reviewed.has(entry.id))
      .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id))[0];
    return opportunity ? this.present(opportunity) : undefined;
  }

  async decide(
    opportunityId: string,
    input: { readonly decision: ProgressiveAutonomyOpportunityReviewDecision; readonly reason?: string }
  ): Promise<ProgressiveAutonomyOpportunityReviewReceipt> {
    const normalizedId = opportunityId.trim();
    if (!isDecision(input.decision)) throw new TypeError("invalid progressive autonomy review decision");
    const opportunity = (await this.store.list()).find((entry) => entry.id === normalizedId);
    if (!opportunity) throw new TypeError(`progressive autonomy opportunity '${normalizedId}' does not exist`);
    if (opportunity.envelope.userId !== this.options.ownerUserId) {
      throw new TypeError("progressive autonomy opportunity belongs to a different user");
    }
    if (opportunity.evidenceClass !== "organic") {
      throw new TypeError("only organic opportunities can be reviewed");
    }
    const reason = normalizeReason(input.reason);
    const existing = (await this.store.listReviews())
      .find((entry) => entry.opportunityId === opportunity.id);
    if (existing) {
      const { reason: _existingReason, ...existingWithoutReason } = existing;
      return this.store.recordReview({
        ...existingWithoutReason,
        decision: input.decision,
        ...(reason === undefined ? {} : { reason }),
        recordedAt: this.now().toISOString()
      });
    }
    const currentSource = await this.resolveCurrentSource(opportunity);
    if (currentSource.state === "unavailable") {
      throw new TypeError(`current source is unavailable: ${currentSource.reason}`);
    }
    if (input.decision === "would-approve" && currentSource.state !== "exact") {
      throw new TypeError("would-approve requires exact current source");
    }
    const identity = `${this.options.ownerUserId}\u0000${opportunity.id}`;
    return this.store.recordReview({
      action: opportunity.envelope.action,
      decision: input.decision,
      evidenceClass: "organic",
      id: `opportunity-review-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
      linkedAt: opportunity.envelope.link.linkedAt,
      opportunityId: opportunity.id,
      ownerUserId: this.options.ownerUserId,
      ...(reason === undefined ? {} : { reason }),
      recordedAt: this.now().toISOString(),
      runId: opportunity.runId,
      ...(currentSource.state === "stale" ? { sourceReason: currentSource.reason } : {}),
      sourceState: currentSource.state,
      taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId,
      toolCallId: opportunity.toolCallId
    });
  }

  private async present(
    opportunity: ProgressiveAutonomyRuntimeOpportunityReceipt
  ): Promise<ProgressiveAutonomyOpportunityReviewPresentation> {
    return {
      action: opportunity.envelope.action,
      currentSource: await this.resolveCurrentSource(opportunity),
      evidenceClass: "organic",
      linkedAt: opportunity.envelope.link.linkedAt,
      opportunityId: opportunity.id,
      ownerUserId: opportunity.envelope.userId,
      recordedAt: opportunity.recordedAt,
      runId: opportunity.runId,
      shadowAssessment: opportunity.shadowAssessment,
      shadowRationale: opportunity.shadowRationale,
      taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId,
      toolCallId: opportunity.toolCallId
    };
  }

  private async resolveCurrentSource(
    opportunity: ProgressiveAutonomyRuntimeOpportunityReceipt
  ): Promise<ProgressiveAutonomyCurrentSource> {
    let state: Awaited<ReturnType<typeof readAttunementState>>;
    let task: Awaited<ReturnType<typeof readTaskByIdStrict>>;
    try {
      [state, task] = await Promise.all([
        readAttunementState(this.options.attunementFile),
        readTaskByIdStrict(this.options.tasksFile, opportunity.envelope.link.taskId)
      ]);
    } catch {
      return { reason: "recorded source stores cannot be read or validated", state: "unavailable" };
    }
    const thread = state.threads.find((entry) => entry.id === opportunity.envelope.threadId);
    if (!thread) return { reason: "recorded thread is missing", state: "stale" };
    const link = thread.links.find((entry) => entry.artifactType === "task"
      && entry.artifactId === opportunity.envelope.link.taskId
      && entry.providerId === "local"
      && entry.role === "next-step"
      && entry.linkedBy === "user"
      && entry.linkedAt === opportunity.envelope.link.linkedAt);
    if (!link) return { reason: "exact user-authored local next-step link is stale", state: "stale" };
    if (!task) return { reason: "recorded task is missing", state: "stale" };
    if (task.status !== "open") return { reason: "recorded task is no longer open", state: "stale" };
    return { state: "exact" };
  }
}

function isDecision(value: unknown): value is ProgressiveAutonomyOpportunityReviewDecision {
  return value === "would-approve" || value === "would-deny" || value === "needs-adjustment";
}

function normalizeReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const reason = value.trim();
  if (reason.length === 0) return undefined;
  if (reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new TypeError("review reason must be at most 500 control-character-free characters");
  }
  return reason;
}
