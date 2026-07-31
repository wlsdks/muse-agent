import {
  projectVerifiedExperienceLearningPromotionHealth,
  projectVerifiedExperienceLearningRollbackProposalHealth,
  verifyExperienceLearningPromotionHandleBinding,
  type ExperienceLearningPromotionHandle,
  type ExperienceLearningRollbackProposal,
  type ExperienceLearningPromotionReceipt
} from "@muse/attunement";
import type { AdaptationLoopHealthInput } from "@muse/shared";

export interface LatestAdaptationLoopHealthObserver {
  observe(receipt: unknown, handle?: unknown): void;
  observeRollbackProposal(proposal: unknown): void;
  snapshot(): AdaptationLoopHealthInput | undefined;
}

/**
 * Keeps the latest fully recomputed adaptation promotion projection and may
 * attach a verified inert rollback proposal only to that exact promotion
 * handle. It grants no mutation authority and equal timestamps settle
 * independently of callback arrival order.
 */
export function createLatestAdaptationLoopHealthObserver(): LatestAdaptationLoopHealthObserver {
  let latest: {
    readonly appliedAtMs: number;
    readonly evidenceId: string;
    readonly handleId?: string;
    readonly health: AdaptationLoopHealthInput;
    readonly proposalEvidenceId?: string;
  } | undefined;

  return Object.freeze({
    observe(value: unknown, handleValue?: unknown): void {
      const health = projectVerifiedExperienceLearningPromotionHealth(value);
      if (!health) return;
      const receipt = value as ExperienceLearningPromotionReceipt;
      const handle = handleValue === undefined
        ? undefined
        : verifyExperienceLearningPromotionHandleBinding(receipt, handleValue);
      if (handleValue !== undefined && !handle) return;
      const appliedAtMs = Date.parse(receipt.appliedAt);
      const evidenceId = health.evidenceId ?? "";
      const order = comparePromotionOrder(appliedAtMs, evidenceId, latest);
      if (order > 0
        || (order === 0
          && latest !== undefined
          && latest.health.status !== "rollback-proposed"
          && handle !== undefined
          && (latest.handleId === undefined || handle.handleId > latest.handleId))) {
        latest = promotionState(appliedAtMs, evidenceId, health, handle);
      }
    },
    observeRollbackProposal(value: unknown): void {
      const health = projectVerifiedExperienceLearningRollbackProposalHealth(value);
      if (!health || !latest?.handleId) return;
      const proposal = value as ExperienceLearningRollbackProposal;
      if (proposal.handleId !== latest.handleId) return;
      const evidenceId = health.evidenceId ?? "";
      if (latest.health.status === "rollback-proposed"
        && evidenceId <= (latest.proposalEvidenceId ?? "")) {
        return;
      }
      latest = Object.freeze({
        ...latest,
        health,
        proposalEvidenceId: evidenceId
      });
    },
    snapshot(): AdaptationLoopHealthInput | undefined {
      return latest?.health;
    }
  });
}

function comparePromotionOrder(
  appliedAtMs: number,
  evidenceId: string,
  latest: {
    readonly appliedAtMs: number;
    readonly evidenceId: string;
  } | undefined
): number {
  if (!latest || appliedAtMs > latest.appliedAtMs) return 1;
  if (appliedAtMs < latest.appliedAtMs) return -1;
  if (evidenceId > latest.evidenceId) return 1;
  return evidenceId < latest.evidenceId ? -1 : 0;
}

function promotionState(
  appliedAtMs: number,
  evidenceId: string,
  health: AdaptationLoopHealthInput,
  handle: ExperienceLearningPromotionHandle | undefined
): {
  readonly appliedAtMs: number;
  readonly evidenceId: string;
  readonly handleId?: string;
  readonly health: AdaptationLoopHealthInput;
} {
  return Object.freeze({
    appliedAtMs,
    evidenceId,
    ...(handle ? { handleId: handle.handleId } : {}),
    health
  });
}
