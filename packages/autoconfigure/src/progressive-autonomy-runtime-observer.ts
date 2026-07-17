import { createHash } from "node:crypto";

import type { ToolOpportunityObserver, ToolOpportunityObserverInput } from "@muse/agent-core";
import { readAttunementState } from "@muse/attunement";
import {
  COMPLETE_LINKED_NEXT_STEP_ACTION,
  evaluateProgressiveAutonomy,
  type ProgressiveAutonomyActionEnvelope,
  type StandingGrantRecord
} from "@muse/policy";
import { readTaskById } from "@muse/stores";
import { FileProgressiveAutonomyAuthorityReader } from "@muse/stores/host-progressive-autonomy";
import {
  FileProgressiveAutonomyOpportunityStore,
  type ProgressiveAutonomyRuntimeOpportunityReceipt
} from "@muse/stores/host-progressive-autonomy-opportunities";

import {
  isProgressiveAutonomyOrganicAuthority,
  type ProgressiveAutonomyOrganicAuthority
} from "./progressive-autonomy-organic-authority.js";

const POLICY_VERSION = 1;
const EXECUTOR_VERSION = 1;

export interface ProgressiveAutonomyToolOpportunityObserverOptions {
  readonly attunementFile: string;
  readonly autonomyFile: string;
  readonly defaultUserId?: string;
  readonly evidenceClass?: "controlled";
  readonly now?: () => Date;
  readonly opportunitiesFile: string;
  readonly tasksFile: string;
}

export function createProgressiveAutonomyToolOpportunityObserver(
  options: ProgressiveAutonomyToolOpportunityObserverOptions
): ToolOpportunityObserver {
  return (input) => observeProgressiveAutonomyToolOpportunity(input, options);
}

/** Composition-root seam; deliberately absent from the package barrel. */
export function createTrustedProgressiveAutonomyToolOpportunityObserver(
  options: ProgressiveAutonomyToolOpportunityObserverOptions,
  authority: ProgressiveAutonomyOrganicAuthority
): ToolOpportunityObserver {
  if (!isProgressiveAutonomyOrganicAuthority(authority)) {
    throw new TypeError("trusted progressive-autonomy organic authority required");
  }
  return (input) => observeWithEvidenceClass(input, options, "organic");
}

export async function observeProgressiveAutonomyToolOpportunity(
  input: ToolOpportunityObserverInput,
  options: ProgressiveAutonomyToolOpportunityObserverOptions
): Promise<ProgressiveAutonomyRuntimeOpportunityReceipt | undefined> {
  return observeWithEvidenceClass(
    input,
    options,
    options.evidenceClass === "controlled" ? "controlled" : "unclassified"
  );
}

async function observeWithEvidenceClass(
  input: ToolOpportunityObserverInput,
  options: ProgressiveAutonomyToolOpportunityObserverOptions,
  evidenceClass: ProgressiveAutonomyRuntimeOpportunityReceipt["evidenceClass"]
): Promise<ProgressiveAutonomyRuntimeOpportunityReceipt | undefined> {
  if (input.toolName !== "muse.tasks.complete") return undefined;
  const taskId = input.arguments.id;
  const userId = input.userId?.trim() || options.defaultUserId?.trim();
  if (typeof taskId !== "string" || taskId.trim().length === 0 || !userId) return undefined;

  const canonicalTaskId = taskId.trim();
  const state = await readAttunementState(options.attunementFile);
  const matches = state.threads.flatMap((thread) => thread.links
    .filter((link) => link.artifactType === "task"
      && link.artifactId === canonicalTaskId
      && link.providerId === "local"
      && link.role === "next-step"
      && link.linkedBy === "user")
    .map((link) => ({ link, thread })));
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  const task = await readTaskById(options.tasksFile, canonicalTaskId);
  if (!task || task.status !== "open") return undefined;

  const envelope: ProgressiveAutonomyActionEnvelope = {
    action: COMPLETE_LINKED_NEXT_STEP_ACTION,
    idempotencyKey: `runtime-opportunity:${input.runId}:${canonicalTaskId}`,
    link: {
      artifactType: "task",
      linkedAt: match.link.linkedAt,
      providerId: "local",
      role: "next-step",
      taskId: canonicalTaskId
    },
    schemaVersion: 1,
    threadId: match.thread.id,
    traceId: `runtime-tool:${input.runId}:${input.toolCallId}`,
    transition: { from: "open", to: "done" },
    userId
  };

  const now = (options.now ?? (() => new Date()))();
  let authorityStatus: "exact" | "corrupt" = "exact";
  let grantRecords: readonly StandingGrantRecord[] = [];
  try {
    grantRecords = await new FileProgressiveAutonomyAuthorityReader({
      file: options.autonomyFile
    }).listGrantRecords();
  } catch {
    authorityStatus = "corrupt";
  }
  const activeGrant = authorityStatus === "exact"
    ? selectActiveExactGrant(grantRecords, envelope, now)
    : undefined;
  const remainingUses = activeGrant
    ? activeGrant.grant.maxUses - activeGrant.usedCount
    : 0;
  const decision = evaluateProgressiveAutonomy({
    authorityStatus,
    envelope,
    executorVersion: EXECUTOR_VERSION,
    ...(activeGrant ? { grant: activeGrant.grant, grantStatus: "active" as const } : {}),
    mode: "shadow",
    now,
    policyVersion: POLICY_VERSION,
    remainingUses
  });
  const identity = `${input.runId}\u0000${input.toolCallId}\u0000${canonicalTaskId}`;
  const receipt: ProgressiveAutonomyRuntimeOpportunityReceipt = {
    evidenceClass,
    enforcementDecision: decision.enforcementDecision,
    envelope,
    id: `runtime-opportunity-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
    ...(activeGrant ? { matchedGrantId: activeGrant.grant.id } : {}),
    origin: "runtime-opportunity",
    rationale: decision.rationale,
    recordedAt: now.toISOString(),
    runId: input.runId,
    shadowAssessment: decision.shadowAssessment,
    shadowRationale: decision.shadowRationale,
    toolCallId: input.toolCallId
  };
  return new FileProgressiveAutonomyOpportunityStore({ file: options.opportunitiesFile }).record(receipt);
}

function selectActiveExactGrant(
  records: readonly StandingGrantRecord[],
  envelope: ProgressiveAutonomyActionEnvelope,
  now: Date
): StandingGrantRecord | undefined {
  const nowMs = now.getTime();
  return [...records]
    .filter((record) => !record.revokedAt
      && Date.parse(record.grant.expiresAt) > nowMs
      && record.grant.maxUses - record.usedCount > 0
      && exactGrantScope(record, envelope))
    .sort((left, right) =>
      left.grant.expiresAt.localeCompare(right.grant.expiresAt)
      || (left.grant.maxUses - left.usedCount) - (right.grant.maxUses - right.usedCount)
      || left.grant.issuedAt.localeCompare(right.grant.issuedAt)
      || left.grant.id.localeCompare(right.grant.id)
    )[0];
}

function exactGrantScope(record: StandingGrantRecord, envelope: ProgressiveAutonomyActionEnvelope): boolean {
  const grant = record.grant;
  return grant.action === envelope.action
    && grant.userId === envelope.userId
    && grant.threadId === envelope.threadId
    && grant.link.artifactType === envelope.link.artifactType
    && grant.link.linkedAt === envelope.link.linkedAt
    && grant.link.providerId === envelope.link.providerId
    && grant.link.role === envelope.link.role
    && grant.link.taskId === envelope.link.taskId
    && grant.transition.from === envelope.transition.from
    && grant.transition.to === envelope.transition.to
    && grant.policyVersion === POLICY_VERSION
    && grant.executorVersion === EXECUTOR_VERSION;
}
