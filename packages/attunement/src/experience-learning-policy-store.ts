import { assertPlainDataTree } from "@muse/shared";

import {
  ExperienceLearningPromotionError,
  promoteExperienceLearningCandidate,
  rollbackExperienceLearningPromotion,
  rollbackExperienceLearningPromotionHandle,
  type ExperienceLearningPolicyCompareAndSwap,
  type ExperienceLearningPromotionInput,
  type ExperienceLearningPromotionReceipt,
  type ExperienceLearningRollbackReceipt
} from "./experience-learning-promotion.js";
import {
  verifyExperienceLearningApprovalReceipt
} from "./experience-learning-approval.js";
import type { ExperienceLearningProposalPreview } from "./experience-learning-preview.js";
import type { ExperienceLearningReplayBundle } from "./experience-learning-replay-evidence.js";
import { readAttunementState, writeAttunementState } from "./attunement-store.js";
import type { ActiveAttunementPolicyWriteGate } from "./active-policy-write-gate.js";
import { mutateFileState } from "./file-state-mutation.js";
import { fingerprintContinuityPolicy } from "./policy-digest.js";
import type { AttunementState, ContinuityPolicy } from "./types.js";

export interface ApprovedExperienceLearningPromotionInput
  extends Pick<
    ExperienceLearningPromotionInput,
    "appliedAt" | "candidate" | "currentPolicy" | "nextPolicyVersion"
  > {
  readonly approvalReceipt: unknown;
  readonly preview: ExperienceLearningProposalPreview;
  readonly replayBundle: ExperienceLearningReplayBundle;
}

/**
 * Binds the content-derived owner approval receipt to the exact preview,
 * replay bundle, and policy mutation. Callers cannot replace verified approval
 * with a hand-built authority-shaped object between verification and CAS.
 */
export async function promoteApprovedExperienceLearningContinuityPolicy(
  file: string,
  input: ApprovedExperienceLearningPromotionInput,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate | undefined
): Promise<ExperienceLearningPromotionReceipt> {
  try {
    assertPlainDataTree(input, "approvedExperienceLearningPromotionInput");
  } catch {
    throw new ExperienceLearningPromotionError("invalid-input");
  }
  const approval = verifyExperienceLearningApprovalReceipt(
    input.approvalReceipt,
    input.preview,
    input.replayBundle,
    input.appliedAt
  );
  if (!approval) {
    throw new ExperienceLearningPromotionError("invalid-approval");
  }
  return promoteExperienceLearningContinuityPolicyUnchecked(file, {
    approval: {
      approvedAt: approval.approvedAt,
      authority: approval.authority,
      candidateId: approval.candidateId,
      replayInputHash: approval.replayInputHash
    },
    appliedAt: input.appliedAt,
    candidate: input.candidate,
    currentPolicy: input.currentPolicy,
    nextPolicyVersion: input.nextPolicyVersion,
    replay: input.replayBundle.replay,
    replayCases: input.replayBundle.cases.map((entry) => ({
      baseline: {
        evidenceHash: entry.baseline.evidenceHash,
        passed: entry.baseline.passed
      },
      caseId: entry.caseId,
      challenger: {
        evidenceHash: entry.challenger.evidenceHash,
        passed: entry.challenger.passed
      }
    }))
  }, activePolicyWriteGate);
}

async function promoteExperienceLearningContinuityPolicyUnchecked(
  file: string,
  input: ExperienceLearningPromotionInput,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate | undefined
): Promise<ExperienceLearningPromotionReceipt> {
  return promoteExperienceLearningCandidate(
    input,
    activePolicyWriteGate,
    createStoreCompareAndSwap(file)
  );
}

export async function rollbackExperienceLearningContinuityPolicy(
  file: string,
  receipt: ExperienceLearningPromotionReceipt,
  rolledBackAt: string,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate | undefined
): Promise<ExperienceLearningRollbackReceipt> {
  const snapshot = await readAttunementState(file);
  return rollbackExperienceLearningPromotion(
    receipt,
    rolledBackAt,
    snapshot.nextPolicyVersion,
    activePolicyWriteGate,
    createStoreCompareAndSwap(file)
  );
}

export async function rollbackExperienceLearningContinuityPolicyByHandleId(
  file: string,
  handleId: string,
  rolledBackAt: string,
  activePolicyWriteGate: ActiveAttunementPolicyWriteGate | undefined
): Promise<ExperienceLearningRollbackReceipt> {
  if (typeof handleId !== "string" || handleId.trim() !== handleId || handleId.length === 0) {
    throw new ExperienceLearningPromotionError("invalid-input");
  }
  const snapshot = await readAttunementState(file);
  const matches = (snapshot.experienceLearningPromotionHandles ?? [])
    .filter((handle) => handle.handleId === handleId);
  if (matches.length !== 1) {
    throw new ExperienceLearningPromotionError("invalid-input");
  }
  const handle = matches[0]!;
  if ((snapshot.experienceLearningPolicyAudits ?? []).some((audit) =>
    audit.kind === "rollback" && audit.sourceId === handle.promotionAuditId
  )) {
    throw new ExperienceLearningPromotionError("stale-active-policy");
  }
  return rollbackExperienceLearningPromotionHandle(
    handle,
    rolledBackAt,
    snapshot.nextPolicyVersion,
    activePolicyWriteGate,
    createStoreCompareAndSwap(file)
  );
}

function createStoreCompareAndSwap(file: string): ExperienceLearningPolicyCompareAndSwap {
  return (transition) => mutateFileState(
    file,
    readAttunementState,
    writeAttunementState,
    (state) => {
      const thread = state.threads.find((entry) => entry.id === transition.threadId);
      const promotionHandle = transition.promotionHandle;
      if (!thread
        || (transition.audit.kind === "promotion"
          ? promotionHandle === undefined
            || promotionHandle.promotionAuditId !== transition.audit.id
          : promotionHandle !== undefined)
        || state.nextPolicyVersion !== transition.policyAfter.version
        || !samePolicy(thread.policy, transition.policyBefore)
        || fingerprintContinuityPolicy(thread.policy) !== transition.expectedDigest
        || fingerprintContinuityPolicy(transition.policyBefore) !== transition.expectedDigest
        || fingerprintContinuityPolicy(transition.policyAfter) !== transition.nextDigest) {
        return unchanged(state);
      }
      const nextState: AttunementState = {
        ...state,
        experienceLearningPolicyAudits: [
          ...(state.experienceLearningPolicyAudits ?? []),
          transition.audit
        ],
        experienceLearningPromotionHandles: [
          ...(state.experienceLearningPromotionHandles ?? []),
          ...(promotionHandle ? [promotionHandle] : [])
        ],
        nextPolicyVersion: state.nextPolicyVersion + 1,
        threads: state.threads.map((entry) =>
          entry.id === thread.id ? { ...entry, policy: transition.policyAfter } : entry
        )
      };
      return { changed: true, result: true, state: nextState };
    }
  );
}

function samePolicy(left: ContinuityPolicy, right: ContinuityPolicy): boolean {
  return left.detail === right.detail
    && left.nextStep === right.nextStep
    && left.suppression === right.suppression
    && left.version === right.version;
}

function unchanged(state: AttunementState) {
  return { changed: false as const, result: false, state };
}
