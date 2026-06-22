/**
 * Pairwise evidence analysis: detect retrieved notes that make the SAME
 * statement about the SAME topic but assert a DIFFERENT value — genuine
 * value-conflicts annotated into DATA before the model sees them.
 */

import { cosineSimilarity } from "./episodic-recall.js";
import type { KnowledgeMatch } from "./knowledge-ranking.js";
import { lexicalTokens } from "./recall-lexical.js";
import { comparableScript } from "./script-family.js";

/**
 * A flagged pair of evidence notes that state the SAME THING but with a
 * DIFFERENT VALUE (e.g. "flight at 3pm" vs "flight at 6pm").
 * `aIndex` and `bIndex` are the two conflicting notes' positions in the
 * original array — no recency ordering implied (score ≠ recency).
 *
 * Detection method from Mem0 (arXiv:2504.19413, Chhikara et al. 2025):
 * detect when a retrieved fact contradicts a stored one, applied here
 * at READ-TIME to annotate conflicting evidence pairs BEFORE the model
 * sees them — moving reconciliation from a fragile prompt instruction
 * into deterministic DATA.
 */
export interface ContradictionPair {
  readonly aIndex: number;
  readonly bIndex: number;
  readonly topicSim: number;
}

const CONTRADICTION_TOPIC_SIM_MIN = 0.86;
const CONTRADICTION_STATEMENT_OVERLAP_MIN = 0.5;

/**
 * Detect evidence notes that make the SAME STATEMENT about the SAME TOPIC but
 * assert a DIFFERENT VALUE — genuine value-conflicts, not paraphrases or
 * elaborations.
 *
 * The signal (precision-first — when unsure, returns nothing):
 * 1. Same-script guard: skip cross-script pairs. Lexical value-comparison is
 *    unreliable cross-lingual (the recurring fire-28/36/39 lesson). Fail-open:
 *    a missed cross-lingual conflict = today's behaviour (safe).
 * 2. Topic gate: cosine(embed(A), embed(B)) ≥ TOPIC_SIM_MIN → same topic.
 * 3. HIGH token overlap + neither-subset = value-conflict skeleton.
 *    HIGH overlap (tokenOverlapRatio ≥ STATEMENT_OVERLAP_MIN) means the notes
 *    share the STATEMENT SKELETON. The neither-subset gate (|A\B|≥1 AND |B\A|≥1)
 *    kills elaboration false-positives: "meeting at 2pm" ⊂ "meeting at 2pm in
 *    room 4" → A is a subset of B → NOT a conflict. Mutual difference at the
 *    value level (each note has ≥1 token absent from the other) is required.
 *
 * Fail-open: any embed error → no pairs → today's behaviour.
 * Never throws, never mutates, never calls an LLM.
 */
/**
 * The pairwise contradiction-detection CORE (shared policy): given a list of texts,
 * return index pairs that are SAME-TOPIC (cosine ≥ topicSimMin) but VALUE-DISAGREEING
 * (high token overlap = same statement skeleton, AND neither-subset = a mutual value
 * difference, not an elaboration). Same-script guard + fail-open on embed error.
 * One detector so the evidence layer ({@link detectEvidenceContradictions}) and the
 * fan-in layer (`detectSubtaskConflicts`) can never drift on the contradiction policy.
 * Pure over the injected embed; never throws.
 */
export async function detectPairwiseContradictions(
  texts: readonly string[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly statementOverlapMin?: number }
): Promise<readonly ContradictionPair[]> {
  const topicSimMin = opts?.topicSimMin ?? CONTRADICTION_TOPIC_SIM_MIN;
  const statementOverlapMin = opts?.statementOverlapMin ?? CONTRADICTION_STATEMENT_OVERLAP_MIN;

  if (texts.length < 2) return [];

  let embeddings: Array<readonly number[] | null>;
  try {
    embeddings = await Promise.all(texts.map((t) => embed(t).catch(() => null)));
  } catch {
    return [];
  }

  const pairs: ContradictionPair[] = [];

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;

      // Same-script guard: cross-script pairs are always skipped (fail-open).
      if (!comparableScript(a, b)) continue;

      const embA = embeddings[i];
      const embB = embeddings[j];
      if (!embA || !embB) continue;

      const topicSim = cosineSimilarity(embA, embB);
      if (topicSim < topicSimMin) continue;

      const tokA = lexicalTokens(a);
      const tokB = lexicalTokens(b);
      const unionSize = new Set([...tokA, ...tokB]).size;
      if (unionSize === 0) continue;
      let intersect = 0;
      for (const t of tokA) {
        if (tokB.has(t)) intersect++;
      }
      const overlapRatio = intersect / unionSize;
      if (overlapRatio < statementOverlapMin) continue;

      // Neither-subset gate: both must each have ≥1 content token absent from the
      // other. Kills elaboration false-positives — an elaboration (one is a superset
      // of the other) has |A\B|=0 or |B\A|=0.
      if (tokA.size - intersect === 0 || tokB.size - intersect === 0) continue;

      // aIndex = i (the earlier index in the array); no score-based ordering
      // because score reflects query relevance, not recency.
      pairs.push({ aIndex: i, bIndex: j, topicSim });
    }
  }

  return pairs;
}

export async function detectEvidenceContradictions(
  matches: readonly KnowledgeMatch[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly statementOverlapMin?: number }
): Promise<readonly ContradictionPair[]> {
  return detectPairwiseContradictions(matches.map((m) => m.text), embed, opts);
}
