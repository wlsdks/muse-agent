import { cosineSimilarity } from "./episodic-recall.js";
import { detectPairwiseContradictions } from "./evidence-conflicts.js";
import { lexicalTokens } from "./knowledge-recall.js";

// Jaccard similarity between two token sets (arXiv:2503.05856 — outlier screen).
// Two EMPTY sets return 0 (no shared content) — not 1 — so a content-empty peer
// cannot masquerade as high-support.
function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) { if (b.has(t)) inter++; }
  return inter / (a.size + b.size - inter);
}

export interface CouncilUtterance {
  /** The participating peer's id (e.g. "phone", "alice"). */
  readonly peerId: string;
  /** Their reasoning about the question. */
  readonly reasoning: string;
}

export type CouncilConsensusStrength = "strong" | "weak";

/**
 * Classify the panel's aggregate consensus strength from the per-member support
 * distribution (ConfMAD, arXiv:2509.14034 — Lin & Hooi EMNLP'25: carry a confidence
 * signal through multi-agent aggregation rather than treating all consensus as equally
 * trustworthy). ADVISORY-ONLY per arXiv:2511.07784 (consensus masks flawed reasoning;
 * agreement is a confidence signal, never a truth signal — this result must never gate
 * or alter the synthesized answer).
 *
 * MEDIAN not min: robust against one low-but-surviving member after the outlier screen.
 * Mirrors screenCouncilOutliers' median use. Solo/empty panel → "strong" (no disagreement
 * possible).
 */
export function classifyCouncilConsensus(
  supports: readonly number[],
  opts: { readonly floor: number }
): CouncilConsensusStrength {
  if (supports.length <= 1) return "strong";
  const sorted = [...supports].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
  return median < opts.floor ? "weak" : "strong";
}

export interface CouncilAnswer {
  readonly answer: string;
  /** Peer ids whose reasoning the answer drew on — always a subset of the inputs. */
  readonly contributors: readonly string[];
  /** Peers quarantined by the consensus-outlier screen before synthesis (arXiv:2503.05856). Omitted when none. */
  readonly excludedPeers?: readonly { readonly peerId: string; readonly reason: string }[];
  /** Advisory signal: "weak" when the panel's median pairwise support fell below the floor (ConfMAD arXiv:2509.14034). Never alters the answer. */
  readonly consensus?: CouncilConsensusStrength;
}

export interface OutlierScreenOptions {
  /** Minimum panel size before any exclusion is attempted. Default 3. */
  readonly minPanel?: number;
  /** A member's mean pairwise similarity below this absolute floor is suspect. Default 0.08. */
  readonly absFloor?: number;
  /** Suspect only when support is also below relFloor × median(support). Default 0.5. */
  readonly relFloor?: number;
  /**
   * Precomputed per-member support values (e.g. from `councilMemberSupportsSemantic`).
   * When provided, these replace the internally-computed Jaccard supports and the
   * caller-supplied `absFloor` applies (or `COSINE_ABS_FLOOR` when not set).
   */
  readonly precomputedSupports?: readonly number[];
}

export interface CouncilScreenResult {
  readonly kept: readonly CouncilUtterance[];
  readonly excluded: readonly { readonly peerId: string; readonly reason: "consensus-outlier" }[];
}

/**
 * Each member's mean pairwise Jaccard token-similarity to all OTHER members.
 * Empty reasoning → support 0 (a silent/failed peer can't claim high agreement).
 * Pure, deterministic, order-stable.
 */
export function councilMemberSupports(utterances: readonly CouncilUtterance[]): number[] {
  const n = utterances.length;
  if (n === 0) return [];
  const tokens: Set<string>[] = utterances.map((u) => lexicalTokens(u.reasoning));
  return utterances.map((_, i) => {
    if (n === 1) return 1;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (j !== i) {
        sum += jaccardSimilarity(tokens[i] ?? new Set<string>(), tokens[j] ?? new Set<string>());
      }
    }
    return sum / (n - 1);
  });
}

/**
 * Embedding cosine threshold for the semantic outlier screen (arXiv:2507.14649 — Cleanse:
 * semantic consistency over embedding space instead of surface lexical overlap). These
 * replace the Jaccard absFloor (0.08) when a `councilMemberSupportsSemantic` vector is
 * fed to `screenCouncilOutliers`.
 *
 * Calibrated on the live embedder (nomic-embed-text-v2-moe, eval:council-floors):
 * genuinely AGREEING cross-lingual/paraphrase members' mean pairwise cosine ranges
 * 0.25–0.55 depending on phrasing, while a semantically unrelated member sits ≤ 0.05.
 * The floor must sit BELOW the worst genuine agreement and ABOVE the noise band —
 * the original 0.4 put real agreeing KO/EN members inside the candidate zone, so in
 * a high-median (echo-similar majority) panel a cross-lingual agreeing peer phrased
 * at cosine ~0.3 would satisfy BOTH screen conditions and be false-dropped. 0.15
 * keeps ~1.6x headroom under the weakest measured agreement (0.246) and ~3x over
 * the unrelated band (0.03–0.05). eval:council-floors pins the separation live.
 */
export const COSINE_ABS_FLOOR = 0.15;

/**
 * Each member's mean pairwise embedding cosine-similarity to all OTHER members.
 * Implements the Cleanse semantic consistency signal (arXiv:2507.14649, Joo & Cho 2025):
 * embedding space catches cross-lingual and paraphrase agreement that Jaccard misses.
 *
 * n===1 → [1] (sole speaker trivially agrees with no one).
 * An empty vector (length 0) or a failed embed → that member's support = 0, mirroring
 * the empty-Jaccard silent-peer rule — a failed embed cannot claim agreement.
 * Never throws: embed errors are caught per-member; a failing member gets support 0.
 */
export async function councilMemberSupportsSemantic(
  utterances: readonly CouncilUtterance[],
  embed: (text: string) => Promise<readonly number[]>
): Promise<number[]> {
  const n = utterances.length;
  if (n === 0) return [];
  const vecs: (readonly number[])[] = await Promise.all(
    utterances.map(async (u) => {
      if (u.reasoning.trim().length === 0) return [];
      try { return await embed(u.reasoning); } catch { return []; }
    })
  );
  return utterances.map((_, i) => {
    if (n === 1) return 1;
    const vi = vecs[i] ?? [];
    if (vi.length === 0) return 0;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const vj = vecs[j] ?? [];
      sum += vj.length === 0 ? 0 : cosineSimilarity(vi, vj);
    }
    return sum / (n - 1);
  });
}

/**
 * True iff n ≤ 1 (solo panel trivially agrees) OR every member's support ≥ agreeAt.
 * ReConcile consensus gate (arXiv:2309.13007): terminates the debate round budget
 * early when the panel has converged, avoiding wasted inference on already-agreed results.
 * Never throws — an empty-reasoning member gets support 0 → not consensus.
 */
export const DEFAULT_COUNCIL_AGREE_AT = 0.16;
// 2× the outlier absFloor (0.08): paraphrased agreement scores ~0.19+, divergent panels
// score 0.02–0.06. This gap is wide enough to be stable across realistic lexical variation.

export function hasCouncilConsensus(
  utterances: readonly CouncilUtterance[],
  opts?: { readonly agreeAt?: number }
): boolean {
  const n = utterances.length;
  if (n <= 1) return true;
  const agreeAt = opts?.agreeAt ?? DEFAULT_COUNCIL_AGREE_AT;
  const supports = councilMemberSupports(utterances);
  return supports.every((s) => s >= agreeAt);
}

/**
 * Topic-coherence bar for the semantic ReConcile consensus gate (arXiv:2309.13007
 * + arXiv:2507.14649 — Cleanse). It is the FIRST half of the gate; the value-
 * conflict detector is the second (see hasCouncilConsensusSemantic).
 *
 * LIVE-CALIBRATED (eval:council-floors). The original 0.5 was set on the belief
 * that agreeing peers score ≥0.6 — measured, a fully AGREEING KO/EN panel's
 * weakest member support is 0.319, so the gate could NEVER fire and the debate
 * early-exit was dead code on any multilingual or paraphrase-diverse panel.
 * 0.25 sits below that band and well above the unrelated-member band (0.03-0.05),
 * so an off-topic panel still fails the bar. Distinct from COSINE_ABS_FLOOR
 * (0.15) — that quarantines a single deceptive member; this asks whether the
 * WHOLE panel is talking about one thing.
 */
export const DEFAULT_COUNCIL_AGREE_AT_COSINE = 0.25;

/**
 * Semantic ReConcile consensus gate (arXiv:2309.13007 + arXiv:2507.14649 — Cleanse):
 * uses embedding cosine instead of lexical Jaccard so cross-lingual panels (KO+EN) that
 * genuinely agree are not falsely scored as diverged.
 *
 * n ≤ 1 → true. Else: every member's mean pairwise cosine must be ≥ agreeAt.
 * Fail-open: a thrown embed inside councilMemberSupportsSemantic yields support 0
 * for that member (the primitive's own contract) → consensus fails → no throw here.
 * Keep hasCouncilConsensus (Jaccard) as the no-embed fallback; this does NOT replace it.
 */
export async function hasCouncilConsensusSemantic(
  utterances: readonly CouncilUtterance[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly agreeAt?: number }
): Promise<boolean> {
  const n = utterances.length;
  if (n <= 1) return true;
  const agreeAt = opts?.agreeAt ?? DEFAULT_COUNCIL_AGREE_AT_COSINE;
  const supports = await councilMemberSupportsSemantic(utterances, embed);
  if (!supports.every((s) => s >= agreeAt)) return false;
  // Pairwise prose cosine measures TOPIC, not AGREEMENT — measured, a member who
  // disagrees on the VALUES while discussing the same subject scores HIGHER (0.56)
  // than a genuinely agreeing cross-lingual member (0.32). So a cosine bar alone
  // cannot be a consensus gate: set high it never fires (the old 0.5 was above the
  // agreement band entirely — the debate could never early-exit), set low it
  // declares consensus over an unresolved disagreement, which is the dangerous
  // direction. Cosine answers "same subject"; the value-conflict detector answers
  // "same answer" — consensus needs BOTH.
  const conflicts = await detectPairwiseContradictions(utterances.map((u) => u.reasoning), embed);
  return conflicts.length === 0;
}

/**
 * The panel's consensus LEVEL as a scalar: the MINIMUM member support (mean
 * pairwise embedding cosine). This is the exact signal hasCouncilConsensusSemantic
 * thresholds — consensus ⟺ min support ≥ agreeAt — exposed so a debate loop can
 * track whether a refinement round actually MOVED the panel toward agreement.
 * n ≤ 1 → 1 (a solo/empty panel trivially agrees). Fail-soft: a failed embed
 * gives that member support 0 (councilMemberSupportsSemantic's contract), lowering
 * the min — never throws.
 */
export async function councilConsensusScore(
  utterances: readonly CouncilUtterance[],
  embed: (text: string) => Promise<readonly number[]>
): Promise<number> {
  if (utterances.length <= 1) return 1;
  const supports = await councilMemberSupportsSemantic(utterances, embed);
  return supports.length === 0 ? 0 : Math.min(...supports);
}
