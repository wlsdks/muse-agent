/**
 * The test-time grounding verifier — the code-not-model half of "shows its
 * work": a deterministic multi-criterion rubric that judges a recall answer
 * against its evidence and a best-of-N selector over candidate drafts.
 */

import { citedSourcesIn } from "./grounding-citations.js";
import type { KnowledgeMatch } from "./knowledge-ranking.js";
import { classifyRetrievalConfidence, DEFAULT_CONFIDENT_AT } from "./recall-confidence.js";
import { finiteOr, lexicalTokens } from "./recall-lexical.js";

export type GroundingVerdict = "grounded" | "weak" | "ungrounded";

export interface GroundingRubric {
  /** Retrieval confidence (CRAG): confident → 1, ambiguous → 0.5, none → 0. */
  readonly confidence: number;
  /** Fraction of the answer's content tokens supported by the retrieved evidence. */
  readonly coverage: number;
  /** Fraction of the query's content tokens addressed by the retrieved evidence. */
  readonly answerability: number;
  /** Fraction of the answer's `[from <source>]` citations that resolve to a retrieved source. */
  readonly citationValidity: number;
}

export interface GroundingVerification {
  readonly verdict: GroundingVerdict;
  readonly rubric: GroundingRubric;
  readonly reason: string;
  /** Cited sources that resolve to NO retrieved match — fabricated citations. */
  readonly invalidCitations: readonly string[];
}

export interface VerifyGroundingOptions {
  /** Absolute-cosine threshold for the confidence criterion (default `DEFAULT_CONFIDENT_AT`). */
  readonly confidentAt?: number;
  /** Min answer-token support for a non-ungrounded verdict (default 0.5). */
  readonly coverageFloor?: number;
  /** Min query-token coverage by the evidence for a grounded verdict (default 0.34). */
  readonly answerabilityFloor?: number;
  /**
   * Number of judge samples to draw for each reverify call (1–5, default 1).
   * Unanimous agreement required to PASS (self-consistency, arXiv:2203.11171).
   * Default 1 preserves byte-identical behaviour for all existing callers.
   */
  readonly reverifySamples?: number;
}

export const DEFAULT_COVERAGE_FLOOR = 0.5;
export const DEFAULT_ANSWERABILITY_FLOOR = 0.34;

export function unionContentTokens(matches: readonly KnowledgeMatch[]): Set<string> {
  const out = new Set<string>();
  for (const m of matches) {
    for (const token of lexicalTokens(m.text)) out.add(token);
  }
  return out;
}

function coveredFraction(tokens: Set<string>, evidence: Set<string>): number {
  if (tokens.size === 0) return 0;
  let hit = 0;
  for (const token of tokens) {
    if (evidence.has(token)) hit += 1;
  }
  return hit / tokens.size;
}

/**
 * Independent, deterministic test-time verifier for the recall wedge — the
 * "shows its work" gate scaled from a single cosine threshold to a multi-
 * criterion rubric (test-time rubric-guided verification, arXiv:2601.15808 +
 * ReasoningBank MaTTS, adapted to a local model with NO weight updates). Where
 * `enforceAnswerCitations` edits the text, this JUDGES the whole answer against
 * the evidence it was grounded on and returns one verdict — separating the
 * answer-maker from the verifier (the harness "maker ≠ judge" gate).
 *
 * - `grounded`  — confident retrieval, the answer's claims are backed by the
 *   evidence, the query is addressed, and every citation resolves. Surface it.
 * - `weak`      — only weakly relevant evidence (ambiguous cosine) but otherwise
 *   consistent. The caller falls back to "I'm not sure" (slice 1) or a 1-shot
 *   LLM re-verification (slice 2).
 * - `ungrounded`— nothing retrieved, a fabricated citation, or claims the
 *   evidence does not support. Dropped by CODE — fabrication can't reach the user.
 *
 * Citations are the `[from <source>]` form, resolved case/space-insensitively
 * against the retrieved sources (notes are identifiers — exact match, mirroring
 * `enforceAnswerCitations`).
 */
export function verifyGrounding(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  options?: VerifyGroundingOptions
): GroundingVerification {
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const coverageFloor = finiteOr(options?.coverageFloor, DEFAULT_COVERAGE_FLOOR);
  const answerabilityFloor = finiteOr(options?.answerabilityFloor, DEFAULT_ANSWERABILITY_FLOOR);

  const retrieval = classifyRetrievalConfidence(matches, { confidentAt });
  const confidence = retrieval === "confident" ? 1 : retrieval === "ambiguous" ? 0.5 : 0;

  const evidence = unionContentTokens(matches);
  const answerTokens = lexicalTokens(answer.replace(/\[[^\]]*\]/gu, " "));
  const coverage = coveredFraction(answerTokens, evidence);
  const answerability = query.trim().length === 0 ? 1 : coveredFraction(lexicalTokens(query), evidence);

  const sourceSet = new Set(matches.map((m) => m.source.trim().toLowerCase()));
  const cited = citedSourcesIn(answer);
  const invalidCitations = cited.filter((src) => !sourceSet.has(src.trim().toLowerCase()));
  const citationValidity = cited.length === 0 ? 1 : (cited.length - invalidCitations.length) / cited.length;

  const rubric: GroundingRubric = { answerability, citationValidity, confidence, coverage };

  if (retrieval === "none") {
    return { invalidCitations, reason: "no evidence retrieved", rubric, verdict: "ungrounded" };
  }
  if (invalidCitations.length > 0) {
    return { invalidCitations, reason: "answer cites a source that was not retrieved", rubric, verdict: "ungrounded" };
  }
  if (coverage < coverageFloor) {
    return { invalidCitations, reason: "answer makes claims the evidence does not support", rubric, verdict: "ungrounded" };
  }
  if (confidence === 1 && answerability >= answerabilityFloor) {
    return { invalidCitations, reason: "confident, covered, and fully cited", rubric, verdict: "grounded" };
  }
  return { invalidCitations, reason: "evidence only weakly supports the answer", rubric, verdict: "weak" };
}

export interface BestGroundedDraft {
  readonly index: number;
  readonly draft: string;
  readonly verification: GroundingVerification;
}

/**
 * Best-of-N selection over recall drafts: verify every draft with the same
 * deterministic rubric and keep the best GROUNDED survivor — "weak" is never
 * accepted, so re-sampling can only raise the answered rate, not admit a
 * fabrication (small models can't self-verify; the owned verifier selects).
 */
export function selectBestGroundedDraft(
  drafts: readonly string[],
  matches: readonly KnowledgeMatch[],
  query: string,
  options?: VerifyGroundingOptions
): BestGroundedDraft | undefined {
  let best: BestGroundedDraft | undefined;
  let bestScore = -1;
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const verification = verifyGrounding(draft, matches, query, options);
    if (verification.verdict !== "grounded") {
      continue;
    }
    const { answerability, citationValidity, confidence, coverage } = verification.rubric;
    const score = answerability + citationValidity + confidence + coverage;
    if (score > bestScore) {
      best = { draft, index, verification };
      bestScore = score;
    }
  }
  return best;
}
