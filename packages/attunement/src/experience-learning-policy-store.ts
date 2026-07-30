import {
  promoteExperienceLearningCandidate,
  rollbackExperienceLearningPromotion,
  type ExperienceLearningPolicyCompareAndSwap,
  type ExperienceLearningPromotionInput,
  type ExperienceLearningPromotionReceipt,
  type ExperienceLearningRollbackReceipt
} from "./experience-learning-promotion.js";
import { readAttunementState, writeAttunementState } from "./attunement-store.js";
import type { ActiveAttunementPolicyWriteGate } from "./active-policy-write-gate.js";
import { mutateFileState } from "./file-state-mutation.js";
import { fingerprintContinuityPolicy } from "./policy-digest.js";
import type { AttunementState, ContinuityPolicy } from "./types.js";

export async function promoteExperienceLearningContinuityPolicy(
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

function createStoreCompareAndSwap(file: string): ExperienceLearningPolicyCompareAndSwap {
  return (transition) => mutateFileState(
    file,
    readAttunementState,
    writeAttunementState,
    (state) => {
      const thread = state.threads.find((entry) => entry.id === transition.threadId);
      if (!thread
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
