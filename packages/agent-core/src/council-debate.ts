import { cosineSimilarity } from "./episodic-recall.js";

import { type CouncilUtterance, councilMemberSupportsSemantic } from "./council-consensus.js";

/**
 * Minimum consensus-score gain a refinement round must produce to be worth
 * continuing. 0.01 cosine: a round that moves every member's agreement by less
 * than this is treated as non-progress.
 */
export const DEFAULT_DEBATE_MIN_DELTA = 0.01;

/**
 * MAST step-repetition / no-termination-awareness guard (arXiv:2503.13657): a
 * debate refinement round is worth continuing ONLY if it moved the panel toward
 * consensus by at least `minDelta`. A round that left the consensus score flat or
 * LOWER (members talking past each other / oscillating) is non-progress — the loop
 * should stop and synthesise from what's there rather than burn the remaining round
 * budget on a panel that isn't converging. Fail-open: a non-finite score (a
 * measurement glitch) returns true (continue) so the guard never stops a debate on
 * bad data — the existing round cap still bounds the loop.
 */
export function debateProgressed(
  prevScore: number,
  currScore: number,
  minDelta: number = DEFAULT_DEBATE_MIN_DELTA
): boolean {
  if (!Number.isFinite(prevScore) || !Number.isFinite(currScore)) return true;
  return currScore - prevScore >= minDelta;
}

/**
 * Below this self-cosine a peer has ABANDONED its own prior-round stance (its new
 * reasoning points a different way than what it argued last round). Cosine-scale,
 * same nomic band as the council floors.
 */
export const COUNCIL_SELF_STANCE_FLOOR = 0.5;

export interface ConformityFlip {
  readonly peerId: string;
}

/**
 * Conformity-flip detection across a debate round (arXiv:2606.00820, "Not All
 * Flips Are Conformity"): a peer that reaches agreement by ABANDONING its own
 * prior stance and moving toward the panel is conforming, not reasoning — and
 * conformity flips are 57–77% correct→wrong, so a consensus reached *via*
 * conformity is untrustworthy. For each peer present in BOTH rounds, flag it when
 * BOTH hold: (a) self-reversal — cosine(own prior reasoning, own current
 * reasoning) < selfStanceFloor (it changed its OWN mind); (b) it moved TOWARD the
 * panel — its mean pairwise support rose from the prior round to the current.
 *
 * Semantic (embedding cosine), not lexical — a peer that rephrases the SAME stance
 * (high self-cosine) is not flagged. Fail-safe: a peer new this round, or one whose
 * embed throws, is NOT a flip (we never invent conformity on missing data). Never
 * throws.
 */
export async function detectConformityFlips(
  prior: readonly CouncilUtterance[],
  current: readonly CouncilUtterance[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly selfStanceFloor?: number }
): Promise<readonly ConformityFlip[]> {
  const floor = opts?.selfStanceFloor ?? COUNCIL_SELF_STANCE_FLOOR;
  if (prior.length === 0 || current.length < 2) return [];
  const priorById = new Map(prior.map((u) => [u.peerId, u]));
  const priorSupports = await councilMemberSupportsSemantic(prior, embed);
  const currentSupports = await councilMemberSupportsSemantic(current, embed);
  const priorSupportById = new Map(prior.map((u, i) => [u.peerId, priorSupports[i] ?? 0]));
  const flips: ConformityFlip[] = [];
  for (let i = 0; i < current.length; i++) {
    const cur = current[i]!;
    const prev = priorById.get(cur.peerId);
    if (!prev) continue;
    let selfCos: number;
    try {
      const [pv, cv] = await Promise.all([embed(prev.reasoning), embed(cur.reasoning)]);
      if (pv.length === 0 || cv.length === 0) continue;
      selfCos = cosineSimilarity(pv, cv);
    } catch {
      continue;
    }
    if (selfCos >= floor) continue; // kept its own stance → reasoned, not conformity
    const movedTowardPanel = (currentSupports[i] ?? 0) > (priorSupportById.get(cur.peerId) ?? 0);
    if (movedTowardPanel) flips.push({ peerId: cur.peerId });
  }
  return flips;
}

/**
 * Build the round-2+ debate question for one member — the original question plus
 * a digest of the OTHER members' reasoning, asking it to refine its view in light
 * of theirs (Multiagent Debate, Du et al. 2023, arXiv:2305.14325: agents that see
 * and respond to each other's reasoning across rounds reach better-supported
 * answers). Returns the original question unchanged when no other members spoke.
 */
export function buildDebateQuestion(question: string, ownPeerId: string, utterances: readonly CouncilUtterance[]): string {
  const others = utterances.filter((u) => u.peerId !== ownPeerId && u.reasoning.trim().length > 0);
  if (others.length === 0) return question;
  const digest = others.map((u) => `[${u.peerId}] ${u.reasoning.replace(/\s+/gu, " ").trim()}`).join("\n");
  return `${question}\n\nOther council members reasoned:\n${digest}\n\n` +
    "Refine YOUR reasoning in light of theirs — agree, push back, or sharpen it. " +
    "2-4 sentences, plain text, no personal data.";
}
