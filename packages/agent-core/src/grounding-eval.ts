import { classifyRetrievalConfidence } from "./knowledge-recall.js";
import type { GroundingVerification, KnowledgeMatch, RetrievalConfidence } from "./knowledge-recall.js";

/**
 * Scored, held-out measurement of the "shows its work" edge — turns the
 * `fabrication=0` release claim from a handful of anecdotes into two numbers
 * over a labelled corpus, so the loop can PROVE the edge holds (and that a
 * retrieval/calibration change helped) instead of only asserting it.
 *
 * Two ORTHOGONAL rates (no double-counting), both standard RAG-eval framings:
 *  - FALSE-REFUSAL (RAGAS answer-recall complement): of the questions the
 *    corpus genuinely answers, how often does the gate wrongly refuse? This is
 *    the GUARD-THE-EDGE metric loop-v2 mandates tracking alongside fabrication=0
 *    (a faster/smaller retriever that raises this is a regression, not a win).
 *  - FAITHFULNESS (RAGAS faithfulness / CRAG refusal-correctness): of the
 *    answers the gate must NOT let through (out-of-corpus questions + unfaithful
 *    drift answers), how often does it catch them? This is the fabrication=0
 *    instrument.
 *
 * The scorer is PURE and model-agnostic: retrieval (`rank`) and the grounding
 * verdict (`verify`) are injected, so a unit test exercises the arithmetic with
 * stubs (no Ollama) while the live runner wires `rankKnowledgeChunks` +
 * `verifyGroundingWithReverify` against real local embeddings / Qwen.
 */

export type GroundingEvalKind = "answerable" | "refuse" | "drift";

export interface GroundingEvalCase {
  /**
   * - `answerable`: the fact IS in the corpus; the gate should surface a
   *   grounded, cited answer. A non-grounded verdict here is a FALSE REFUSAL.
   * - `refuse`: the fact is NOT in the corpus; the retrieval gate must not go
   *   `confident` (else the small model would be invited to cite a near-miss).
   * - `drift`: an UNFAITHFUL answer (claims the evidence doesn't support / a
   *   fabricated citation) the gate must catch as `ungrounded`.
   */
  readonly kind: GroundingEvalKind;
  readonly query: string;
  /** `answerable`: a correct, cited reference answer. `drift`: the unfaithful answer to be caught. */
  readonly answer?: string;
  /** Short human label, surfaced on a failing case. */
  readonly note?: string;
}

export interface GroundingEvalCorpus {
  readonly notes: ReadonlyArray<{ readonly source: string; readonly text: string }>;
  readonly cases: readonly GroundingEvalCase[];
}

export interface GroundingEvalDeps {
  /** Real retrieval of the corpus for a query (live: `rankKnowledgeChunks` + embeddings). */
  readonly rank: (query: string) => Promise<readonly KnowledgeMatch[]>;
  /** Grounding verdict for an answer against its evidence (live: `verifyGroundingWithReverify`). */
  readonly verify: (
    answer: string,
    matches: readonly KnowledgeMatch[],
    query: string
  ) => Promise<GroundingVerification>;
  /** Retrieval-confidence verdict; defaults to `classifyRetrievalConfidence` (overridable for tests). */
  readonly classify?: (matches: readonly KnowledgeMatch[]) => RetrievalConfidence;
}

export interface GroundingCaseOutcome {
  readonly kind: GroundingEvalKind;
  readonly query: string;
  readonly note?: string;
  /** answerable: false ⇒ a faithful in-corpus answer was wrongly refused. refuse/drift: false ⇒ fabrication slipped. */
  readonly passed: boolean;
  readonly detail: string;
}

export interface GroundingEvalResult {
  readonly total: number;
  readonly answerable: number;
  readonly refuse: number;
  readonly drift: number;
  /** answerable cases the gate wrongly refused (`verdict !== "grounded"`). */
  readonly falseRefusals: number;
  /** `falseRefusals / answerable` — 0 when there are no answerable cases. Lower is better. */
  readonly falseRefusalRate: number;
  /** refuse + drift cases the gate correctly caught (non-confident retrieval / `ungrounded`). */
  readonly caught: number;
  /** refuse + drift count — the "must not fabricate" denominator. */
  readonly guardable: number;
  /** `caught / guardable` — 1 when there are no guardable cases. Higher is better. */
  readonly faithfulnessRate: number;
  readonly outcomes: readonly GroundingCaseOutcome[];
}

/**
 * Run the labelled corpus through the (injected) real recall + grounding stack
 * and tally the two rates. Division is guarded so an empty/degenerate corpus
 * yields neutral rates (false-refusal 0, faithfulness 1), never `NaN`.
 */
export async function scoreGroundingEval(
  corpus: GroundingEvalCorpus,
  deps: GroundingEvalDeps
): Promise<GroundingEvalResult> {
  const classify = deps.classify ?? ((matches) => classifyRetrievalConfidence(matches));
  const outcomes: GroundingCaseOutcome[] = [];
  let answerable = 0;
  let refuse = 0;
  let drift = 0;
  let falseRefusals = 0;
  let caught = 0;

  for (const testCase of corpus.cases) {
    const matches = await deps.rank(testCase.query);

    if (testCase.kind === "answerable") {
      answerable += 1;
      const verification = await deps.verify(testCase.answer ?? "", matches, testCase.query);
      const refused = verification.verdict !== "grounded";
      if (refused) falseRefusals += 1;
      outcomes.push({
        detail: `verdict=${verification.verdict} (${verification.reason})`,
        kind: testCase.kind,
        note: testCase.note,
        passed: !refused,
        query: testCase.query
      });
      continue;
    }

    if (testCase.kind === "drift") {
      drift += 1;
      const verification = await deps.verify(testCase.answer ?? "", matches, testCase.query);
      const ok = verification.verdict === "ungrounded";
      if (ok) caught += 1;
      outcomes.push({
        detail: `verdict=${verification.verdict} (${verification.reason})`,
        kind: testCase.kind,
        note: testCase.note,
        passed: ok,
        query: testCase.query
      });
      continue;
    }

    // refuse: the fact isn't in the corpus — the retrieval gate must stay
    // non-confident so the model is never invited to cite a near-miss.
    refuse += 1;
    const retrieval = classify(matches);
    const ok = retrieval !== "confident";
    if (ok) caught += 1;
    outcomes.push({
      detail: `retrieval=${retrieval}`,
      kind: testCase.kind,
      note: testCase.note,
      passed: ok,
      query: testCase.query
    });
  }

  const guardable = refuse + drift;
  return {
    answerable,
    caught,
    drift,
    falseRefusalRate: answerable === 0 ? 0 : falseRefusals / answerable,
    falseRefusals,
    faithfulnessRate: guardable === 0 ? 1 : caught / guardable,
    guardable,
    outcomes,
    refuse,
    total: corpus.cases.length
  };
}
