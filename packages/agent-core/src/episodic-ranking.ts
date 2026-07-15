/**
 * Pure retrieval-ranking toolkit for episodic recall: similarity,
 * tokenisation, recency/activation boosts, and the selection passes
 * (CAR cluster-transition, lateral inhibition, Mem0 consolidation,
 * A-MAC conflict flagging). No I/O, no provider state — consumed by
 * the EpisodicRecallProvider implementations in `episodic-recall.ts`.
 */

import { computeActivationBoost } from "./actr-activation.js";
import type { EpisodicMatch, StoredEpisode } from "./episodic-recall.js";
import { comparableScript } from "./script-family.js";

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1].
 * Returns 0 for a length mismatch or a zero-norm vector (no
 * direction → no similarity), so a degenerate embedding can never
 * score above the recall threshold.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  const result = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(result) ? result : 0;
}

// Character class for tokenisable runs. Includes the same CJK ranges
// `memory-token-trim.ts:isCjkCodePoint` already uses, so episodic
// recall works across the same locales the token estimator handles:
//   - a-z 0-9            ASCII text (English, Latin transliterations)
//   - 가-힯      Hangul Syllables + some Jamo Extended-A (Korean)
//   - 一-鿿      CJK Unified Ideographs (Chinese Hanzi + Japanese Kanji)
//   - ぀-ゟ      Hiragana (Japanese)
//   - ゠-ヿ      Katakana (Japanese)
// Hangul alone would leave Japanese / Chinese narratives with an
// empty token set → zero recall, even when query and narrative
// shared every meaningful character.
const TOKEN_NON_WORD_RE = /[^a-z0-9가-힯一-鿿぀-ゟ゠-ヿ]+/u;

const DAY_MS = 24 * 60 * 60 * 1_000;

function hasCjkChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||  // CJK Unified Ideographs
      (code >= 0xac00 && code <= 0xd7af) ||  // Hangul Syllables
      (code >= 0x3040 && code <= 0x309f) ||  // Hiragana
      (code >= 0x30a0 && code <= 0x30ff)     // Katakana
    ) {
      return true;
    }
  }
  return false;
}

export function tokenSet(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().split(TOKEN_NON_WORD_RE)) {
    if (raw.length < 2) {
      continue;
    }
    if (hasCjkChar(raw)) {
      // CJK scripts don't separate words with whitespace, so a
      // contiguous run like "東京で会議" arrives as ONE raw token.
      // Whole-token equality would only match identical phrases —
      // a paraphrase like "東京の会議" would Jaccard to 0. Emit
      // character bigrams instead: the standard dependency-free
      // fallback for CJK tokenisation. "東京で会議" →
      // {"東京","京で","で会","会議"}; the paraphrase shares
      // "東京" and "会議", scoring 2/6 ≈ 0.33 → above the default
      // minScore. ASCII tokens keep their existing whole-word
      // behaviour.
      for (let index = 0; index < raw.length - 1; index += 1) {
        tokens.add(raw.slice(index, index + 2));
      }
    } else {
      tokens.add(raw);
    }
  }
  return tokens;
}

export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection++;
    }
  }
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

/**
 * recency boost. Returns an additive contribution to the
 * episode's similarity score that decays exponentially with episode
 * age:
 *
 *   boost = weight * exp(-age_days / half_life_days)
 *
 * - Brand-new episodes get the full `weight` (default 0.15).
 * - At one half-life (default 14 days) the boost is `weight / 2`.
 * - After ~3 half-lives (~6 weeks) the boost is effectively zero.
 *
 * JARVIS-class personal assistants prefer recently-relevant memory:
 * between two similar narratives, the newer one should rank higher.
 * The boost is ADDED to the Jaccard score AFTER the `minScore`
 * gate, so a recency-only match (no semantic overlap) still can't
 * surface — it would have already been filtered out.
 *
 * Returns 0 when `createdAtIso` is missing / unparseable, or when
 * the configured weight is 0 (feature disabled).
 */
export function episodeTimeBoost(
  episode: StoredEpisode,
  nowMs: number,
  weight: number,
  halfLifeDays: number
): number {
  if (episode.accessTimesIso && episode.accessTimesIso.length > 0) {
    const times = [episode.createdAtIso, ...episode.accessTimesIso]
      .map((iso) => (iso ? Date.parse(iso) : Number.NaN))
      .filter((ms) => Number.isFinite(ms));
    return computeActivationBoost(times, nowMs, weight);
  }
  return computeRecencyBoost(episode.createdAtIso, nowMs, weight, halfLifeDays);
}

export function computeRecencyBoost(
  createdAtIso: string | undefined,
  nowMs: number,
  weight: number,
  halfLifeDays: number
): number {
  if (weight <= 0 || !createdAtIso) {
    return 0;
  }
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) {
    return 0;
  }
  const ageDays = Math.max(0, (nowMs - createdMs) / DAY_MS);
  return weight * Math.exp(-ageDays / halfLifeDays);
}

// WHY inhibition ≠ MMR: MMR reorders for diversity, displacing a relevant
// item with a less-relevant one to maximise coverage. Lateral inhibition
// (arXiv:2601.02744) demotes a REDUNDANT candidate's score by its cosine
// similarity to an already-selected stronger-activation match, then
// re-applies the existing minScore gate. A non-redundant relevant episode
// is never displaced; only near-duplicates that crowd out distinct memory
// are suppressed. Winner-take-most, fail-soft: empty vecs or strength 0
// produce output byte-identical to a plain topK slice.
export const EPISODIC_INHIBITION_STRENGTH = 0.5;

// WHY relative-drop (CAR arXiv:2511.14769) vs absolute-max-gap (selectByScoreGap):
// selectByScoreGap finds the single LARGEST absolute consecutive gap across all
// scores — scale-dependent, so a uniform fade multiplier shifts the cliff.
// selectByClusterTransition tests each adjacent pair with a RELATIVE ratio
// so a uniform multiplier (e.g. FADE_PENALTY) leaves relative drops unchanged;
// only a true relevance cliff (next item < half the previous) triggers the cut.
// WHY 0.5 conservative: at 50% drop the cliff is sharp and unambiguous — marginal
// episodes that are still somewhat relevant (e.g. 0.6 → 0.4, a 33% drop) survive.
// Erring toward today's topK is the right default; a cliff that aggressive is
// almost certainly a true relevance boundary. (CAR arXiv:2511.14769)
export const EPISODIC_CLUSTER_DROP_RATIO = 0.5;

// WHY 0.92: Mem0 near-equivalence threshold (arXiv:2504.19413, Chhikara et al. 2025).
// Conservative so only TRUE near-duplicates (two summaries of the same decision,
// near-identical wording) collapse; a related-but-distinct pair (cosine ~0.6) keeps
// both. Distinct from lateral-inhibition (which DEMOTES the 2nd dup's SCORE but
// never frees the slot — iterates the pre-sorted list and a demoted item still
// occupies a position) and CAR (which detects a SCORE-SEQUENCE cliff, not CONTENT
// duplication between two adjacent high scores). Placed BEFORE CAR so adaptiveK
// is computed on the deduplicated list, freeing a slot for a distinct episode.
export const EPISODIC_CONSOLIDATION_THRESHOLD = 0.92;

/**
 * Retrieval-time near-duplicate consolidation (Mem0, arXiv:2504.19413).
 *
 * Walks `scored` high→low (already sorted); for each candidate computes the max
 * cosine similarity to every already-kept episode. If that max is ≥ threshold the
 * candidate is the lower-ranked near-duplicate and is dropped (consolidated into
 * the stronger-ranked kept one). Otherwise it is kept.
 *
 * SELECTION-ONLY: only drops a near-identical lower-ranked duplicate; never adds a
 * below-minScore episode, never fabricates, never reorders by anything but the
 * existing sort. Fail-soft: empty map OR a candidate/selected missing a vec →
 * 0 similarity → never falsely collapses; pure and deterministic, never throws.
 */
export function consolidateNearDuplicates(
  scored: readonly EpisodicMatch[],
  narrativeVecs: ReadonlyMap<string, readonly number[]>,
  threshold = EPISODIC_CONSOLIDATION_THRESHOLD
): EpisodicMatch[] {
  if (narrativeVecs.size === 0) {
    return [...scored];
  }
  const kept: EpisodicMatch[] = [];
  for (const candidate of scored) {
    const candVec = narrativeVecs.get(candidate.sessionId);
    if (!candVec) {
      kept.push(candidate);
      continue;
    }
    let maxCos = 0;
    for (const sel of kept) {
      const selVec = narrativeVecs.get(sel.sessionId);
      if (selVec) {
        const sim = cosineSimilarity(candVec, selVec);
        if (sim > maxCos) {
          maxCos = sim;
        }
      }
    }
    if (maxCos < threshold) {
      kept.push(candidate);
    }
  }
  return kept;
}

// WHY 0.86 (topic gate) sits BELOW 0.92 (consolidation): a value-conflict pair
// ("flight at 3pm" vs "flight at 6pm") is the SAME topic but NOT a near-duplicate
// — it lands in the [0.86, 0.92) band, so consolidation keeps both and this pass
// flags the lower-relevance one. A pair ≥0.92 was already collapsed (one survives,
// nothing to reconcile). 0.5 statement-overlap = the two share the statement
// skeleton (Mem0 arXiv:2504.19413 / A-MAC arXiv:2603.04549).
const EPISODIC_CONFLICT_TOPIC_SIM_MIN = 0.86;
const EPISODIC_CONFLICT_STATEMENT_OVERLAP_MIN = 0.5;

/**
 * A recalled episode that states the SAME topic but a DIFFERENT value than a
 * higher-relevance recalled episode. `sessionId` is the lower-relevance episode
 * (the one to annotate); `conflictsWith` is the higher-relevance one.
 */
export interface EpisodicConflictFlag {
  readonly sessionId: string;
  readonly conflictsWith: string;
  readonly topicSim: number;
}

/**
 * A-MAC factual-confidence pass (arXiv:2603.04549): flag recalled episodes that
 * CONTRADICT a higher-relevance recalled episode, so reconciliation moves from a
 * fragile prompt instruction into DATA. `matches` are assumed sorted by relevance
 * desc (the providers sort before this runs), so for each conflicting pair the
 * EARLIER index is higher-relevance and the LATER is flagged.
 *
 * The signal (precision-first — when unsure, flags nothing):
 * 1. Same-script guard (cross-lingual value-comparison is unreliable — the
 *    recurring lesson; a missed cross-lingual conflict = today's behaviour).
 * 2. Topic gate: cosine on the ALREADY-COMPUTED narrative vecs ≥ topicSimMin.
 *    Semantic, not lexical — the primary signal.
 * 3. HIGH token overlap (shared statement skeleton) + neither-subset (each has
 *    ≥1 content token the other lacks → a genuine value-conflict, not an
 *    elaboration). Lexical only as the secondary value-conflict discriminator,
 *    guarded by step 1 — mirrors the proven detectEvidenceContradictions.
 *
 * One flag per lower-relevance episode (its highest-relevance conflicting
 * partner). ANNOTATION-only: never drops, never reorders, never widens grounding.
 * Fail-soft: empty vecs OR a missing vec → no flag → today's behaviour. Pure,
 * synchronous (reuses precomputed embeddings), never throws, never calls an LLM.
 */
export function flagEpisodicConflicts(
  matches: readonly EpisodicMatch[],
  narrativeVecs: ReadonlyMap<string, readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly statementOverlapMin?: number }
): readonly EpisodicConflictFlag[] {
  const topicSimMin = opts?.topicSimMin ?? EPISODIC_CONFLICT_TOPIC_SIM_MIN;
  const statementOverlapMin = opts?.statementOverlapMin ?? EPISODIC_CONFLICT_STATEMENT_OVERLAP_MIN;
  if (matches.length < 2 || narrativeVecs.size === 0) {
    return [];
  }
  const flags: EpisodicConflictFlag[] = [];
  for (let j = 1; j < matches.length; j++) {
    const lower = matches[j]!;
    const lowerVec = narrativeVecs.get(lower.sessionId);
    if (!lowerVec) continue;
    const tokLower = tokenSet(lower.narrative);
    for (let i = 0; i < j; i++) {
      const higher = matches[i]!;
      const higherVec = narrativeVecs.get(higher.sessionId);
      if (!higherVec) continue;
      if (!comparableScript(higher.narrative, lower.narrative)) continue;
      const topicSim = cosineSimilarity(higherVec, lowerVec);
      if (topicSim < topicSimMin) continue;
      const tokHigher = tokenSet(higher.narrative);
      const unionSize = new Set([...tokHigher, ...tokLower]).size;
      if (unionSize === 0) continue;
      let intersect = 0;
      for (const t of tokHigher) {
        if (tokLower.has(t)) intersect++;
      }
      if (intersect / unionSize < statementOverlapMin) continue;
      // Neither-subset: an elaboration (one set ⊆ the other) is not a conflict.
      if (tokHigher.size - intersect === 0 || tokLower.size - intersect === 0) continue;
      flags.push({ sessionId: lower.sessionId, conflictsWith: higher.sessionId, topicSim });
      break; // highest-relevance partner wins; one flag per lower episode
    }
  }
  return flags;
}

/**
 * Adaptive top-k cutoff via cluster-transition detection (CAR, arXiv:2511.14769).
 *
 * Walks already-sorted (high→low) scores and returns k = the index after the FIRST
 * pair where the next score is less than `(1 - dropRatio)` of the current —
 * i.e. a relative drop sharp enough to signal a cluster boundary.
 *
 * SELECTION-ONLY: result is always ≤ topK. Never adds an episode. Fail-soft: if no
 * transition is found, or inputs are degenerate, returns topK (byte-identical to the
 * previous fixed slice). Distinct from selectByScoreGap which finds the largest
 * ABSOLUTE gap; this uses a RELATIVE drop ratio so a uniform fade multiplier (which
 * scales all scores proportionally) does NOT move the cut.
 */
export function selectByClusterTransition(
  scoresDescending: readonly number[],
  options: { readonly topK: number; readonly dropRatio?: number }
): number {
  const n = scoresDescending.length;
  if (n === 0) return 0;
  const { topK } = options;
  const dropRatio = typeof options.dropRatio === "number" && Number.isFinite(options.dropRatio)
    ? options.dropRatio
    : EPISODIC_CLUSTER_DROP_RATIO;
  // Any non-finite (NaN/Infinity) or negative score in the array means we can't
  // reason reliably about relative drops — fail-soft to topK.
  for (let i = 0; i < Math.min(n, topK); i++) {
    const s = scoresDescending[i] ?? 0;
    if (!Number.isFinite(s) || s < 0) {
      return topK;
    }
  }
  for (let i = 0; i < Math.min(n - 1, topK - 1); i++) {
    const cur = scoresDescending[i] ?? 0;
    const next = scoresDescending[i + 1] ?? 0;
    if (next < cur * (1 - dropRatio)) {
      return i + 1;
    }
  }
  // No transition found: return the actual available count capped at topK.
  return Math.min(n, topK);
}

/**
 * Greedy lateral-inhibition pass over pre-sorted episodic matches.
 *
 * For each candidate (highest-score first), compute the penalty from
 * its cosine similarity to already-selected episodes. If the inhibited
 * score still clears `minScore`, accept; otherwise drop. Stops at topK.
 *
 * narrativeVecs must be keyed by `EpisodicMatch.sessionId`. Any
 * candidate or selected episode without a vec entry contributes 0
 * similarity to the penalty (safe, not an error).
 */
export function applyLateralInhibition(
  scored: readonly EpisodicMatch[],
  narrativeVecs: ReadonlyMap<string, readonly number[]>,
  options: { topK: number; minScore: number; inhibitionStrength: number }
): EpisodicMatch[] {
  const { topK, minScore, inhibitionStrength } = options;
  if (inhibitionStrength === 0 || narrativeVecs.size === 0) {
    return scored.filter((m) => (m.similarity ?? 0) >= minScore).slice(0, topK);
  }
  const selected: EpisodicMatch[] = [];
  for (const candidate of scored) {
    if (selected.length >= topK) {
      break;
    }
    const candVec = narrativeVecs.get(candidate.sessionId);
    let maxSim = 0;
    if (candVec) {
      for (const sel of selected) {
        const selVec = narrativeVecs.get(sel.sessionId);
        if (selVec) {
          const sim = cosineSimilarity(candVec, selVec);
          if (sim > maxSim) {
            maxSim = sim;
          }
        }
      }
    }
    const penalty = inhibitionStrength * maxSim;
    const inhibited = (candidate.similarity ?? 0) - penalty;
    if (inhibited >= minScore) {
      selected.push(candidate);
    }
  }
  return selected;
}
