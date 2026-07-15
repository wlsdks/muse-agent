/**
 * Pairwise evidence analysis: detect retrieved notes that make the SAME
 * statement about the SAME topic but assert a DIFFERENT value — genuine
 * value-conflicts annotated into DATA before the model sees them.
 */

import { cosineSimilarity } from "./episodic-recall.js";
import type { KnowledgeMatch } from "./knowledge-ranking.js";
import { lexicalTokens } from "./recall-lexical.js";
import { comparableScript } from "./script-family.js";
import { withBestEffort } from "@muse/shared";


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

/**
 * Same-topic floor. LIVE-CALIBRATED (eval:council-floors; nomic-embed-text-v2-moe)
 * — and the calibration inverted the original assumption. A value difference
 * LOWERS the cosine, because the embedding encodes the value: measured, real
 * value-conflict pairs land at 0.66-0.87 ("meeting at 2pm" vs "at 4pm" = 0.664;
 * "월세 25일 90만원" vs "3일 130만원" = 0.791) while benign PARAPHRASES land at
 * 0.86-0.96. The previous 0.86 floor therefore selected almost exactly the wrong
 * population — it skipped real conflicts and admitted paraphrases (which the
 * lexical test then flagged on harmless wording differences: an agreeing panel
 * produced a contradiction, a genuinely disagreeing one produced none).
 *
 * 0.6 admits the whole measured conflict band. Discriminating a conflict from a
 * paraphrase or an elaboration is NOT cosine's job — `valueTokens` below does it.
 */
const CONTRADICTION_TOPIC_SIM_MIN = 0.6;
const CONTRADICTION_STATEMENT_OVERLAP_MIN = 0.5;

/**
 * Cosine at which two statements are the SAME statement, for the polarity test
 * only. Polarity conflict cannot lean on the lexical skeleton overlap: Korean is
 * agglutinative, so "이사하는" and "이사하지" are different tokens and an opposed
 * KO pair's overlap collapses to 0.2 — below the skeleton gate, which then
 * silently drops the disagreement. Cosine is script-neutral, and the separation
 * is wide: measured, opposite-polarity SAME-statement pairs sit at 0.875-0.912
 * (KO 이사/유지 0.875, EN ship/not-ship 0.912, KO 채용/거절 0.895) while a
 * negated sentence on a DIFFERENT statement sits at 0.13-0.24. 0.75 keeps a wide
 * margin on both sides.
 */
const POLARITY_TOPIC_SIM_MIN = 0.75;

const WEEKDAY_MONTH_VALUES = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"
]);

/**
 * The VALUE tokens of a statement — the parts a conflict is ABOUT: bare DIGIT
 * RUNS (amounts, times, dates, counts) plus weekday/month names.
 *
 * Digit RUNS, not digit-bearing tokens: Korean is agglutinative, so the same
 * value carries a different particle in each phrasing ("90만원이야" vs
 * "90만원입니다"), and comparing whole tokens reads that rewording as a
 * different value — which is exactly how an AGREEING panel produced a
 * contradiction. `90` is `90` in both.
 */
function valueTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();

  // NOTATION-NORMALISE before comparing, or a notation variant reads as a
  // different value and an AGREEING pair is flagged — the exact failure this
  // detector exists to prevent. Clock times collapse to minutes-since-midnight
  // ("2pm" and "14:00" are both 840); Korean myriad/hundred-million multipliers
  // and thousands separators collapse to a plain number ("90만원" and
  // "900,000원" are both 900000).
  const consumed: [number, number][] = [];
  const claim = (match: RegExpMatchArray): void => {
    const start = match.index ?? 0;
    consumed.push([start, start + match[0].length]);
  };

  for (const m of lower.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gu)) {
    const hour12 = Number(m[1]);
    const minutes = Number(m[2] ?? "0");
    const hour24 = m[3] === "pm" ? (hour12 % 12) + 12 : hour12 % 12;
    out.add(`t${String(hour24 * 60 + minutes)}`);
    claim(m);
  }
  for (const m of lower.matchAll(/(\d{1,2}):(\d{2})/gu)) {
    out.add(`t${String(Number(m[1]) * 60 + Number(m[2]))}`);
    claim(m);
  }
  for (const m of lower.matchAll(/([\d,]+)\s*(억|만)/gu)) {
    const base = Number((m[1] ?? "0").replace(/,/gu, ""));
    const scale = m[2] === "억" ? 100_000_000 : 10_000;
    out.add(String(base * scale));
    claim(m);
  }
  for (const m of lower.matchAll(/\d[\d,]*\d|\d/gu)) {
    const start = m.index ?? 0;
    if (consumed.some(([from, to]) => start >= from && start < to)) {
      continue;
    }
    out.add(String(Number((m[0] ?? "0").replace(/,/gu, ""))));
  }

  for (const token of lexicalTokens(text)) {
    if (WEEKDAY_MONTH_VALUES.has(token)) {
      out.add(token);
    }
  }
  return out;
}

// Latin markers match on WORD boundaries — a substring test reads the "no" in
// "now" as a negation, which flipped an affirmative peer to negated and made an
// opposed panel look unanimously negative (both sides "negated" ⇒ same polarity
// ⇒ no conflict ⇒ false consensus). Korean is agglutinative, so its markers are
// matched as substrings, but `안` is required to be a standalone word for the
// same reason (안전 / 안내 are not negations).
const NEGATION_EN = /\b(?:not|never|no|cannot|can't|won't|shouldn't|don't|doesn't|didn't|isn't|aren't|without)\b|n't\b/u;
const NEGATION_KO = ["아니", "않", "말고", "없", "못하", "못 "];
const NEGATION_KO_STANDALONE = /(?:^|\s)안(?:\s|$)/u;

/**
 * Whether a statement is NEGATED. Qualitative disagreement carries no value
 * token at all ("we should ship" vs "we should NOT ship"), so a value-only
 * comparison is blind to it — and the natural correcting phrasing ("월세는
 * 90만원이 아니라 130만원입니다") quotes the rival value, making its value set a
 * SUPERSET and defeating the mutual-difference test too. Polarity closes both:
 * same statement, opposite polarity = disagreement, whatever the values do.
 */
function isNegated(text: string): boolean {
  const lower = text.toLowerCase();
  if (NEGATION_EN.test(lower)) return true;
  if (NEGATION_KO_STANDALONE.test(lower)) return true;
  return NEGATION_KO.some((marker) => lower.includes(marker));
}

/**
 * The statement SKELETON — the content tokens that are not carrying a value.
 * Overlap is measured here rather than over all tokens because stop-word
 * stripping leaves short statements value-dominated ("the meeting is at 2pm" →
 * {meeting, 2pm}), so an all-token overlap of a genuine conflict collapses to
 * 0.33 and the pair is skipped before the value test can ever see it.
 */
function skeletonTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of lexicalTokens(text)) {
    if (!/\d/u.test(token) && !WEEKDAY_MONTH_VALUES.has(token)) {
      out.add(token);
    }
  }
  return out;
}

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
    embeddings = await Promise.all(texts.map((t) => withBestEffort(embed(t), null)));
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

      // Statement-skeleton gate: the two notes must be making the same statement
      // (same non-value words) before a value difference means anything.
      const tokA = skeletonTokens(a);
      const tokB = skeletonTokens(b);
      const unionSize = new Set([...tokA, ...tokB]).size;
      let intersect = 0;
      for (const t of tokA) {
        if (tokB.has(t)) intersect++;
      }
      const overlapRatio = unionSize === 0 ? 0 : intersect / unionSize;
      const sameStatementLexically = unionSize > 0 && overlapRatio >= statementOverlapMin;
      // Polarity conflict qualifies "same statement" by COSINE instead — the
      // lexical skeleton is unusable across Korean particle drift (see
      // POLARITY_TOPIC_SIM_MIN).
      const polarityConflict = isNegated(a) !== isNegated(b) && topicSim >= POLARITY_TOPIC_SIM_MIN;
      if (!sameStatementLexically && !polarityConflict) continue;

      // Value-difference gate. Both notes must assert a value, and each must assert
      // one the other does not — a MUTUAL difference at the value level. This is what
      // separates the three cases the previous all-token neither-subset test conflated:
      //   paraphrase   ("…90만원이야" / "…90만원입니다")     → same values      → skip
      //   elaboration  ("2pm" / "2pm in room 4")            → subset values    → skip
      //   real conflict("2pm" / "4pm", "90만원" / "130만원") → mutual difference → PAIR
      const valA = valueTokens(a);
      const valB = valueTokens(b);
      const aHasOwn = [...valA].some((v) => !valB.has(v));
      const bHasOwn = [...valB].some((v) => !valA.has(v));
      // A value conflict still requires the LEXICAL same-statement gate (a mutual
      // value difference between two loosely-related sentences is noise).
      const valuesConflict =
        sameStatementLexically && valA.size > 0 && valB.size > 0 && aHasOwn && bHasOwn;
      // Polarity disagreement is a conflict even when the values agree (or one
      // side has none): "we should ship" vs "we should NOT ship" carries no value
      // token at all, and "90만원이 아니라 130만원" quotes the rival value so its
      // value set is a SUPERSET — both are invisible to a value-only test.
      if (!valuesConflict && !polarityConflict) continue;

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
