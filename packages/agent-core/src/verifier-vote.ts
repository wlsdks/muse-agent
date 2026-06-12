/**
 * BoN-MAV deterministic verifier vote aggregation (arXiv:2502.20379).
 *
 * Each AspectVerifier casts a binary approve/reject per candidate.
 * AggScore = approvals / verifierCount; argmax selects the winner.
 * Tie-break: prefer `preferOnTie` id if present, else first in input order.
 * Empty verifier list → all scores 0 → tie-break path (no NaN).
 */

import type { OrchestrationProposal } from "./orchestrate.js";
import { lexicalTokens } from "./knowledge-recall.js";

export interface AspectVerifier {
  readonly id: string;
  approve(candidate: OrchestrationProposal, question: string): boolean;
}

export interface ScoredCandidate {
  readonly id: string;
  readonly score: number;
  readonly approvals: readonly string[];
}

/**
 * Vote aggregation from arXiv:2502.20379 §3: score each candidate by the
 * fraction of verifiers that approve it, then return the argmax.
 * Throws only on empty candidates array.
 */
export function aggregateVerifierVotes(
  candidates: readonly OrchestrationProposal[],
  verifiers: readonly AspectVerifier[],
  question: string,
  preferOnTie?: string
): { readonly ranked: readonly ScoredCandidate[]; readonly selected: OrchestrationProposal } {
  if (candidates.length === 0) throw new Error("aggregateVerifierVotes: no candidates");

  const scored: ScoredCandidate[] = candidates.map((c) => {
    const approvals: string[] = [];
    for (const v of verifiers) {
      if (v.approve(c, question)) approvals.push(v.id);
    }
    const score = verifiers.length === 0 ? 0 : approvals.length / verifiers.length;
    return { id: c.id, score, approvals };
  });

  const ranked = [...scored].sort((a, b) => b.score - a.score);

  const best = ranked[0]!;
  const topScore = best.score;
  const tied = candidates.filter((c) => {
    const s = scored.find((x) => x.id === c.id);
    return s !== undefined && s.score === topScore;
  });

  let selected: OrchestrationProposal;
  if (tied.length === 1) {
    selected = tied[0]!;
  } else if (preferOnTie !== undefined) {
    selected = tied.find((c) => c.id === preferOnTie) ?? tied[0]!;
  } else {
    selected = tied[0]!;
  }

  return { ranked, selected };
}

/**
 * on-topic: candidate must contain at least `TOPIC_FLOOR` fraction of the
 * question's content tokens — zero overlap means the candidate ignored the question.
 */
const TOPIC_FLOOR = 0.3;
const onTopicVerifier: AspectVerifier = {
  id: "on-topic",
  approve(candidate, question) {
    const qTokens = lexicalTokens(question);
    if (qTokens.size === 0) return true;
    const cTokens = lexicalTokens(candidate.text);
    let overlap = 0;
    for (const t of qTokens) if (cTokens.has(t)) overlap++;
    return overlap / qTokens.size >= TOPIC_FLOOR;
  }
};

/**
 * substantive: candidate must have at least MIN_TOKENS content tokens —
 * a one-liner that merely defers is not a real answer.
 */
const MIN_TOKENS = 4;
const substantiveVerifier: AspectVerifier = {
  id: "substantive",
  approve(candidate) {
    return lexicalTokens(candidate.text).size >= MIN_TOKENS;
  }
};

/**
 * non-hedging: hedge-marker density below HEDGE_FLOOR.
 * RELATIVE ranking only — never converts ALL candidates to rejections
 * (if every candidate hedges, one still wins via tie-break).
 */
const HEDGE_MARKERS = ["i'm not sure", "not sure", "모르겠", "cannot answer", "can't answer", "as an ai", "잘 모르"];
const HEDGE_FLOOR = 0.15;

function hedgeDensity(text: string): number {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/u).filter(Boolean);
  if (words.length === 0) return 0;
  let hits = 0;
  for (const marker of HEDGE_MARKERS) {
    if (lower.includes(marker)) hits++;
  }
  return hits / words.length;
}

const nonHedgingVerifier: AspectVerifier = {
  id: "non-hedging",
  approve(candidate) {
    return hedgeDensity(candidate.text) < HEDGE_FLOOR;
  }
};

export const DEFAULT_ASPECT_VERIFIERS: readonly AspectVerifier[] = [
  onTopicVerifier,
  substantiveVerifier,
  nonHedgingVerifier
];
