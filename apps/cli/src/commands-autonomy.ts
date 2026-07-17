import { randomUUID } from "node:crypto";

import {
  ProgressiveAutonomyOpportunityReviewService,
  resolveAttunementFile,
  resolveDefaultUserId,
  resolveProgressiveAutonomyFile,
  resolveProgressiveAutonomyOpportunitiesFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { completeLinkedNextStep, readAttunementState } from "@muse/attunement";
import { readTaskById } from "@muse/stores";
import { FileProgressiveAutonomyAdminStore } from "@muse/stores/host-progressive-autonomy";
import {
  FileProgressiveAutonomyOpportunityStore,
  type ProgressiveAutonomyOpportunityReviewReceipt,
  type ProgressiveAutonomyRuntimeDecisionReceipt,
  type ProgressiveAutonomyRuntimeOpportunityReceipt
} from "@muse/stores/host-progressive-autonomy-opportunities";
import type { ProgressiveAutonomyShadowReceipt } from "@muse/policy";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

type Environment = Record<string, string | undefined>;

function parseBoundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum.toString()} to ${maximum.toString()}`);
  }
  return parsed;
}

function fail(io: ProgramIO, cause: unknown): void {
  io.stderr(`autonomy: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 2;
}

type ReportReceipt = Pick<ProgressiveAutonomyShadowReceipt, "envelope" | "recordedAt" | "shadowAssessment" | "shadowRationale">;

function summarizeShadowReceipts(receipts: readonly ReportReceipt[]) {
  const counts = { wouldAllowStanding: 0, wouldConfirm: 0, wouldDeny: 0 };
  const days = new Set<string>();
  const tasks = new Set<string>();
  const threads = new Set<string>();
  const rationaleCounts = new Map<string, number>();
  for (const receipt of receipts) {
    counts[receipt.shadowAssessment] += 1;
    days.add(receipt.recordedAt.slice(0, 10));
    tasks.add(receipt.envelope.link.taskId);
    threads.add(receipt.envelope.threadId);
    rationaleCounts.set(receipt.shadowRationale, (rationaleCounts.get(receipt.shadowRationale) ?? 0) + 1);
  }
  return {
    assessments: counts,
    observedDecisions: receipts.length,
    rationales: [...rationaleCounts.entries()]
      .map(([rationale, count]) => ({ count, rationale }))
      .sort((left, right) => left.rationale.localeCompare(right.rationale)),
    unique: { days: days.size, tasks: tasks.size, threads: threads.size }
  };
}

export function buildShadowReport(
  manualReceipts: readonly ProgressiveAutonomyShadowReceipt[],
  runtimeReceipts: readonly ProgressiveAutonomyRuntimeOpportunityReceipt[] = [],
  reviewReceipts: readonly ProgressiveAutonomyOpportunityReviewReceipt[] = [],
  runtimeDecisionReceipts: readonly ProgressiveAutonomyRuntimeDecisionReceipt[] = []
) {
  const uniqueRuntime = [...new Map(runtimeReceipts.map((receipt) => [
    `${receipt.runId}\u0000${receipt.envelope.action}\u0000${receipt.envelope.link.taskId}`,
    receipt
  ])).values()];
  const runtimeById = new Map(uniqueRuntime.map((receipt) => [receipt.id, receipt]));
  const organicOpportunities = uniqueRuntime.filter((receipt) => receipt.evidenceClass === "organic");
  const validRuntimeDecisions = [...new Map(runtimeDecisionReceipts
    .filter((decision) => runtimeDecisionMatchesOpportunity(decision, runtimeById.get(decision.opportunityId)))
    .map((decision) => [decision.opportunityId, decision])).values()];
  const runtimeDecisionIds = new Set(validRuntimeDecisions.map((entry) => entry.opportunityId));
  const validReviews = [...new Map(reviewReceipts
    .filter((review) => reviewMatchesOpportunity(review, runtimeById.get(review.opportunityId))
      && !runtimeDecisionIds.has(review.opportunityId))
    .map((review) => [review.opportunityId, review])).values()];
  const decisions = { "needs-adjustment": 0, "would-approve": 0, "would-deny": 0 };
  const reviewDays = new Set<string>();
  const reviewTasks = new Set<string>();
  const reviewThreads = new Set<string>();
  for (const review of validReviews) {
    decisions[review.decision] += 1;
    reviewDays.add(review.recordedAt.slice(0, 10));
    reviewTasks.add(review.taskId);
    reviewThreads.add(review.threadId);
  }
  for (const runtimeDecision of validRuntimeDecisions) {
    decisions[runtimeDecision.decision === "approved" ? "would-approve" : "would-deny"] += 1;
    reviewDays.add(runtimeDecision.recordedAt.slice(0, 10));
    reviewTasks.add(runtimeDecision.taskId);
    reviewThreads.add(runtimeDecision.threadId);
  }
  const byEvidenceClass = {
    controlled: uniqueRuntime.filter((receipt) => receipt.evidenceClass === "controlled").length,
    organic: organicOpportunities.length,
    unclassified: uniqueRuntime.filter((receipt) => receipt.evidenceClass === "unclassified").length
  };
  const eligibleReviews = validReviews.length + validRuntimeDecisions.length;
  return {
    review: {
      coverage: organicOpportunities.length === 0 ? 0 : eligibleReviews / organicOpportunities.length,
      decisionDistribution: decisions,
      eligibleReviews,
      minimumEligibleReviews: 20,
      promotion: "explicit-user-decision-only" as const,
      remainingReviews: Math.max(0, 20 - eligibleReviews),
      status: eligibleReviews >= 20 ? "audit-required" as const : "collecting" as const,
      targetEligibleReviews: 50,
      unique: { days: reviewDays.size, tasks: reviewTasks.size, threads: reviewThreads.size },
      unresolvedOrganicOpportunities: Math.max(0, organicOpportunities.length - eligibleReviews)
    },
    schemaVersion: 3 as const,
    sources: {
      manualCli: {
        classification: "legacy-read-only" as const,
        ...summarizeShadowReceipts(manualReceipts)
      },
      runtimeOpportunity: {
        byEvidenceClass,
        classification: "runtime-opportunity-by-provenance" as const,
        excludedFromReadiness: byEvidenceClass.controlled + byEvidenceClass.unclassified,
        ...summarizeShadowReceipts(uniqueRuntime)
      },
      organicReview: {
        classification: "explicit-counterfactual-user-review" as const,
        decisions,
        observedDecisions: eligibleReviews,
        unique: { days: reviewDays.size, tasks: reviewTasks.size, threads: reviewThreads.size }
      }
    }
  };
}

function reviewMatchesOpportunity(
  review: ProgressiveAutonomyOpportunityReviewReceipt,
  opportunity: ProgressiveAutonomyRuntimeOpportunityReceipt | undefined
): boolean {
  return opportunity?.evidenceClass === "organic"
    && review.evidenceClass === "organic"
    && (review.decision !== "would-approve" || review.sourceState === "exact")
    && (review.sourceState === "exact" ? review.sourceReason === undefined : review.sourceReason !== undefined)
    && review.ownerUserId === opportunity.envelope.userId
    && review.runId === opportunity.runId
    && review.toolCallId === opportunity.toolCallId
    && review.action === opportunity.envelope.action
    && review.taskId === opportunity.envelope.link.taskId
    && review.threadId === opportunity.envelope.threadId
    && review.linkedAt === opportunity.envelope.link.linkedAt;
}

function runtimeDecisionMatchesOpportunity(
  decision: ProgressiveAutonomyRuntimeDecisionReceipt,
  opportunity: ProgressiveAutonomyRuntimeOpportunityReceipt | undefined
): boolean {
  return opportunity?.evidenceClass === "organic"
    && decision.origin === "runtime-tool-approval"
    && decision.provenance === "explicit-cli-ink"
    && decision.toolName === "muse.tasks.complete"
    && decision.ownerUserId === opportunity.envelope.userId
    && decision.runId === opportunity.runId
    && decision.toolCallId === opportunity.toolCallId
    && decision.action === opportunity.envelope.action
    && decision.taskId === opportunity.envelope.link.taskId
    && decision.threadId === opportunity.envelope.threadId
    && decision.linkedAt === opportunity.envelope.link.linkedAt;
}

export function registerAutonomyCommands(program: Command, io: ProgramIO): void {
  const autonomy = program.command("autonomy")
    .description("Collect local-only progressive-autonomy shadow evidence under explicit user grants");

  autonomy.command("grant-next-step <threadId>")
    .description("Grant bounded shadow evaluation for this thread's exact open linked next step")
    .option("--expires-in-hours <hours>", "Grant lifetime from 1 to 168 hours", "24")
    .option("--max-uses <uses>", "Maximum live uses from 1 to 50 (shadow never consumes uses)", "20")
    .option("--json", "Print machine-readable JSON")
    .action(async (threadId: string, options: {
      readonly expiresInHours: string;
      readonly json?: boolean;
      readonly maxUses: string;
    }) => {
      try {
        const env = process.env as Environment;
        const normalizedThreadId = threadId.trim();
        const state = await readAttunementState(resolveAttunementFile(env));
        const thread = state.threads.find((candidate) => candidate.id === normalizedThreadId);
        if (!thread) throw new TypeError(`no personal thread with id '${normalizedThreadId}'`);
        const link = thread.links.find((candidate) => candidate.artifactType === "task"
          && candidate.providerId === "local" && candidate.role === "next-step"
          && candidate.linkedBy === "user");
        if (!link) throw new TypeError("thread has no exact user-authored local next-step task link");
        const task = await readTaskById(resolveTasksFile(env), link.artifactId);
        if (!task || task.status !== "open") throw new TypeError("linked next-step task is missing or closed");
        const expiresInHours = parseBoundedInteger(options.expiresInHours, "expires-in-hours", 1, 168);
        const maxUses = parseBoundedInteger(options.maxUses, "max-uses", 1, 50);
        const authorization = Object.freeze({ invocation: randomUUID() });
        const store = new FileProgressiveAutonomyAdminStore({
          file: resolveProgressiveAutonomyFile(env),
          verifyUserAuthorization: (candidate, userId) =>
            candidate === authorization && userId === resolveDefaultUserId(env)
        });
        const now = new Date();
        const grant = await store.issueGrant(authorization, {
          action: "muse.tasks.complete-linked-next-step",
          executorVersion: 1,
          expiresAt: new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString(),
          link: {
            artifactType: "task",
            linkedAt: link.linkedAt,
            providerId: "local",
            role: "next-step",
            taskId: task.id
          },
          maxUses,
          policyVersion: 1,
          schemaVersion: 1,
          threadId: thread.id,
          transition: { from: "open", to: "done" },
          userId: resolveDefaultUserId(env)
        });
        if (options.json) {
          io.stdout(`${JSON.stringify(grant, null, 2)}\n`);
        } else {
          io.stdout(`Granted shadow evaluation for task '${task.id}' until ${grant.expiresAt}.\n`);
          io.stdout(`Next: muse autonomy shadow ${grant.id}\n`);
        }
      } catch (cause) {
        fail(io, cause);
      }
    });

  autonomy.command("list")
    .description("List bounded grants from the owner-only local autonomy store")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { readonly json?: boolean }) => {
      try {
        const env = process.env as Environment;
        const authorization = Object.freeze({ invocation: randomUUID() });
        const store = new FileProgressiveAutonomyAdminStore({
          file: resolveProgressiveAutonomyFile(env),
          verifyUserAuthorization: (candidate, userId) =>
            candidate === authorization && userId === resolveDefaultUserId(env)
        });
        const grants = [...await store.listGrantRecords()].sort((left, right) =>
          left.grant.issuedAt.localeCompare(right.grant.issuedAt) || left.grant.id.localeCompare(right.grant.id)
        );
        if (options.json) {
          io.stdout(`${JSON.stringify({ grants, schemaVersion: 1 }, null, 2)}\n`);
        } else if (grants.length === 0) {
          io.stdout("No progressive-autonomy grants.\n");
          io.stdout("Next: muse autonomy grant-next-step <thread-id>\n");
        } else {
          for (const record of grants) {
            const state = record.revokedAt ? `revoked ${record.revokedAt}` : `active until ${record.grant.expiresAt}`;
            io.stdout(`${record.grant.id}  task=${record.grant.link.taskId}  uses=${record.usedCount.toString()}/${record.grant.maxUses.toString()}  ${state}\n`);
          }
          io.stdout("Next: muse autonomy shadow <grant-id>\n");
        }
      } catch (cause) {
        fail(io, cause);
      }
    });

  autonomy.command("revoke <grantId>")
    .description("Revoke one bounded grant from the owner-only local autonomy store")
    .option("--json", "Print machine-readable JSON")
    .action(async (grantId: string, options: { readonly json?: boolean }) => {
      try {
        const env = process.env as Environment;
        const authorization = Object.freeze({ invocation: randomUUID() });
        const store = new FileProgressiveAutonomyAdminStore({
          file: resolveProgressiveAutonomyFile(env),
          verifyUserAuthorization: (candidate, userId) =>
            candidate === authorization && userId === resolveDefaultUserId(env)
        });
        const revoked = await store.revokeGrant(authorization, grantId.trim());
        if (options.json) {
          io.stdout(`${JSON.stringify(revoked, null, 2)}\n`);
        } else {
          io.stdout(`Revoked ${revoked.grant.id}; no future live claim can use it.\n`);
          io.stdout("Next: muse autonomy report\n");
        }
      } catch (cause) {
        fail(io, cause);
      }
    });

  autonomy.command("shadow <grantId>")
    .description("Record one local-only shadow decision for an existing exact grant")
    .option("--json", "Print machine-readable JSON")
    .action(async (grantId: string, options: { readonly json?: boolean }) => {
      try {
        const env = process.env as Environment;
        const authorization = Object.freeze({ invocation: randomUUID() });
        const store = new FileProgressiveAutonomyAdminStore({
          file: resolveProgressiveAutonomyFile(env),
          verifyUserAuthorization: (candidate, userId) =>
            candidate === authorization && userId === resolveDefaultUserId(env)
        });
        const executor = store.executorStore();
        const record = await executor.getGrant(grantId.trim());
        if (!record) throw new TypeError(`standing grant '${grantId.trim()}' does not exist`);
        if (record.grant.userId !== resolveDefaultUserId(env)) {
          throw new TypeError("standing grant belongs to a different local user identity");
        }
        const executionId = `shadow-${randomUUID()}`;
        await completeLinkedNextStep({
          attunementFile: resolveAttunementFile(env),
          autonomyStore: executor,
          envelope: {
            action: record.grant.action,
            idempotencyKey: executionId,
            link: record.grant.link,
            schemaVersion: record.grant.schemaVersion,
            threadId: record.grant.threadId,
            traceId: executionId,
            transition: record.grant.transition,
            userId: record.grant.userId
          },
          executionId,
          executorVersion: record.grant.executorVersion,
          grantId: record.grant.id,
          mode: "shadow",
          policyVersion: record.grant.policyVersion,
          tasksFile: resolveTasksFile(env)
        });
        const receipt = (await executor.listShadowReceipts())
          .find((candidate) => candidate.executionId === executionId);
        if (!receipt) throw new TypeError("shadow decision did not produce a durable receipt");
        if (options.json) {
          io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
        } else {
          io.stdout(`${receipt.shadowAssessment}: ${receipt.shadowRationale}\n`);
          io.stdout("Task unchanged. Next: muse autonomy report\n");
        }
      } catch (cause) {
        fail(io, cause);
      }
    });

  autonomy.command("review")
    .description("Review the oldest unresolved organic runtime opportunity without executing it")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { readonly json?: boolean }) => {
      try {
        const env = process.env as Environment;
        const opportunity = await createReviewService(env).review();
        if (options.json) {
          io.stdout(`${JSON.stringify({ opportunity: opportunity ?? null, schemaVersion: 1 }, null, 2)}\n`);
        } else if (!opportunity) {
          io.stdout("No unresolved organic progressive-autonomy opportunity.\n");
        } else {
          io.stdout(`${opportunity.opportunityId}  task=${opportunity.taskId}  source=${opportunity.currentSource.state}\n`);
          io.stdout(`Recorded ${opportunity.recordedAt}: ${opportunity.shadowAssessment} — ${opportunity.shadowRationale}\n`);
          io.stdout(`Next: muse autonomy decide ${opportunity.opportunityId} --decision <would-approve|would-deny|needs-adjustment>\n`);
        }
      } catch (cause) {
        fail(io, cause);
      }
    });

  autonomy.command("decide <opportunityId>")
    .description("Record one counterfactual user decision for an organic runtime opportunity")
    .requiredOption("--decision <decision>", "would-approve, would-deny, or needs-adjustment")
    .option("--reason <reason>", "Optional bounded reason")
    .option("--json", "Print machine-readable JSON")
    .action(async (opportunityId: string, options: {
      readonly decision: "needs-adjustment" | "would-approve" | "would-deny";
      readonly json?: boolean;
      readonly reason?: string;
    }) => {
      try {
        const env = process.env as Environment;
        const receipt = await createReviewService(env).decide(opportunityId, {
          decision: options.decision,
          ...(options.reason === undefined ? {} : { reason: options.reason })
        });
        if (options.json) {
          io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
        } else {
          io.stdout(`${receipt.decision}: ${receipt.opportunityId} (${receipt.sourceState})\n`);
          io.stdout("Counterfactual only; no task or authority changed.\n");
        }
      } catch (cause) {
        fail(io, cause);
      }
    });

  autonomy.command("report")
    .description("Summarize real receipts from this resolved local shadow store")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { readonly json?: boolean }) => {
      try {
        const env = process.env as Environment;
        const authorization = Object.freeze({ invocation: randomUUID() });
        const store = new FileProgressiveAutonomyAdminStore({
          file: resolveProgressiveAutonomyFile(env),
          verifyUserAuthorization: (candidate, userId) =>
            candidate === authorization && userId === resolveDefaultUserId(env)
        });
        const opportunities = new FileProgressiveAutonomyOpportunityStore({
          file: resolveProgressiveAutonomyOpportunitiesFile(env)
        });
        const report = buildShadowReport(
          await store.executorStore().listShadowReceipts(),
          await opportunities.list(),
          await opportunities.listReviews(),
          await opportunities.listRuntimeDecisions()
        );
        if (options.json) {
          io.stdout(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          const runtime = report.sources.runtimeOpportunity;
          const manual = report.sources.manualCli;
          io.stdout(`Runtime opportunities: ${runtime.observedDecisions.toString()} (organic ${runtime.byEvidenceClass.organic.toString()}, controlled ${runtime.byEvidenceClass.controlled.toString()}, unclassified ${runtime.byEvidenceClass.unclassified.toString()}).\n`);
          io.stdout(`Legacy manual shadow receipts: ${manual.observedDecisions.toString()} (read-only classification; not counted for readiness).\n`);
          io.stdout(report.review.status === "collecting"
            ? `Collect ${report.review.remainingReviews.toString()} more explicit organic reviews before audit.\n`
            : "Audit required; this does not promote authority.\n");
          io.stdout("Promotion always requires an explicit user decision.\n");
        }
      } catch (cause) {
        fail(io, cause);
      }
    });
}

function createReviewService(env: Environment): ProgressiveAutonomyOpportunityReviewService {
  return new ProgressiveAutonomyOpportunityReviewService({
    attunementFile: resolveAttunementFile(env),
    opportunitiesFile: resolveProgressiveAutonomyOpportunitiesFile(env),
    ownerUserId: resolveDefaultUserId(env),
    tasksFile: resolveTasksFile(env)
  });
}
