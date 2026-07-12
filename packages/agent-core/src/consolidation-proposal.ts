/**
 * Sleep-consolidation candidates (D6-S1a scoring) become DRAFT proposals
 * here — never durable writes. Muse forgets on correction and must never
 * promote an episodic memory to durable storage without the user's
 * explicit confirmation; a "keep this long-term?" card is the only path
 * from candidate to promotion, and the confirmation itself is out of
 * scope for this pass (D6-S1c daemon consumes the user's reply later).
 *
 * `ConsolidationProposalPassDeps.promote` exists only to make the
 * no-auto-write contract explicit and testable — this module must never
 * call it. A call site that invokes it here is a correctness bug, not a
 * style nit: it would silently promote memories the user never approved.
 */

import {
  scoreConsolidationCandidate,
  isConsolidationCandidate,
  DEFAULT_CONSOLIDATION_THRESHOLD,
  type ConsolidationCandidateSignals
} from "./consolidation-score.js";
import type { AgentInitiatedNotice } from "./agent-initiated-notice.js";

export const CONSOLIDATION_PROPOSAL_KIND = "memory_consolidation_proposal";

export interface ConsolidationProposalCandidate {
  readonly memoryId: string;
  /** Short human-readable text describing the memory, shown in the proposal card. */
  readonly summary: string;
  readonly signals: ConsolidationCandidateSignals;
}

export interface ConsolidationProposalPassDeps {
  readonly candidates: readonly ConsolidationProposalCandidate[];
  readonly nowMs: number;
  /** ISO timestamp for the drafted notices — passed in, never `Date.now()`. */
  readonly nowIso: string;
  readonly threshold?: number;
  readonly halfLifeDays?: number;
  /** Draft delivery — publishes the proposal notice for the user to review/confirm. */
  readonly publish: (notice: AgentInitiatedNotice) => void;
  /**
   * The durable-promotion WRITER. It is part of the daemon's capability
   * set, but this pass MUST NEVER call it — promotion is user-confirmed
   * only (correction-forgetting invariant). Kept in deps so the
   * no-auto-write contract is explicit and testable; a call here is a bug.
   */
  readonly promote?: (memoryId: string) => void | Promise<void>;
}

export interface ConsolidationProposalPassResult {
  readonly published: number;
  readonly proposals: readonly AgentInitiatedNotice[];
}

/**
 * Build ONE draft proposal notice for a candidate. Pure — it drafts a
 * user-facing "keep this long-term?" card; it does NOT promote or write.
 */
export function buildConsolidationProposalNotice(
  candidate: ConsolidationProposalCandidate,
  nowIso: string
): AgentInitiatedNotice {
  return {
    kind: CONSOLIDATION_PROPOSAL_KIND,
    text: `이 기억을 오래 보관할까요? "${candidate.summary}" (승인해야 durable로 승격됩니다)`,
    generatedAt: nowIso,
    sourceId: candidate.memoryId
  };
}

/**
 * Score each candidate (D6-S1a), and for those clearing the bar PUBLISH a
 * draft proposal. NEVER promotes/writes — `deps.promote` is intentionally
 * never invoked. Returns the drafted proposals (selection only).
 */
export function runConsolidationProposalPass(
  deps: ConsolidationProposalPassDeps
): ConsolidationProposalPassResult {
  const threshold = deps.threshold ?? DEFAULT_CONSOLIDATION_THRESHOLD;
  const proposals: AgentInitiatedNotice[] = [];
  for (const candidate of deps.candidates) {
    const score = scoreConsolidationCandidate(
      candidate.signals,
      deps.nowMs,
      deps.halfLifeDays !== undefined ? { halfLifeDays: deps.halfLifeDays } : undefined
    );
    if (!isConsolidationCandidate(score, threshold)) {
      continue;
    }
    const notice = buildConsolidationProposalNotice(candidate, deps.nowIso);
    deps.publish(notice);
    proposals.push(notice);
  }
  return { published: proposals.length, proposals };
}
