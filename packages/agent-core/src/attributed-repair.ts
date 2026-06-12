import type { GroundingVerification, KnowledgeMatch } from "./knowledge-recall.js";

/**
 * Attributed self-repair — RARR (Researching and Revising What Language Models
 * Say, arXiv:2210.08726), adapted to the local model with NO weight updates.
 * When the recall wedge returns an UNGROUNDED verdict, the edge today only
 * WARNS. This makes it constructive: one local pass rewrites the answer
 * constrained to the retrieved evidence, and the rewrite is shown ONLY if it
 * then re-verifies GROUNDED through the SAME gate (citation check + rubric +
 * weak-band/value-escalation judge). Fail-CLOSED: a rewrite that refuses, fails
 * the gate, or still doesn't verify is dropped — the honest refusal stands, so
 * the repair can never fabricate a fix (fabrication=0 preserved).
 */

export const REPAIR_SYSTEM_PROMPT =
  "You correct a draft answer so that every claim is supported by the EVIDENCE. " +
  "Rewrite the answer using ONLY facts stated in the EVIDENCE, and cite each fact inline as [from <source>] " +
  "using the exact source label shown in brackets before each evidence line. " +
  'If the EVIDENCE does not actually answer the QUESTION, reply exactly: "I\'m not sure — that isn\'t in your notes." ' +
  "Never introduce a fact, number, date, or name that is not present in the EVIDENCE.";

export interface AttributedRepairPromptInput {
  readonly query: string;
  /** The retrieved passages, each prefixed with its `[source]` label. */
  readonly evidence: string;
  /** The original (ungrounded) draft answer. */
  readonly answer: string;
}

export function buildAttributedRepairPrompt(input: AttributedRepairPromptInput): string {
  return [
    `QUESTION: ${input.query}`,
    "EVIDENCE:",
    input.evidence,
    "",
    `DRAFT ANSWER (may contain claims the evidence does not support): ${input.answer}`,
    "",
    "Rewrite the answer using ONLY the evidence above, citing each fact as [from <source>]. " +
      "If the evidence does not answer the question, say you're not sure."
  ].join("\n");
}

export interface AttributedRepairDeps {
  /** One-shot rewrite constrained to the evidence (injected local-Qwen pass). */
  readonly rewrite: (input: AttributedRepairPromptInput) => Promise<string>;
  /** Grounding verdict for the rewrite — live: `verifyGroundingWithReverify` over the same evidence. */
  readonly verify: (answer: string, matches: readonly KnowledgeMatch[], query: string) => Promise<GroundingVerification>;
  /** Citation gate applied to the rewrite before verifying (live: `enforceAnswerCitations`). */
  readonly gate?: (answer: string) => string;
  /** Refusal detector — a rewrite that refuses is NOT a correction (live: `answerIsRefusal`). */
  readonly isRefusal?: (answer: string) => boolean;
}

export interface AttributedRepairResult {
  /** The corrected answer — present ONLY when the rewrite re-verifies GROUNDED. */
  readonly repaired?: string;
  /** Why a repair was or wasn't produced. */
  readonly reason: string;
}

function formatRepairEvidence(matches: readonly KnowledgeMatch[]): string {
  return matches.map((match) => `[${match.source}] ${match.text}`).join("\n");
}

/**
 * Attempt to rewrite an ungrounded answer into one fully supported by the
 * evidence. Returns `repaired` ONLY when the rewrite clears the citation gate,
 * is not itself a refusal, and re-verifies GROUNDED. Any other outcome (no
 * evidence, rewrite error, refusal, still-ungrounded) yields no repair — the
 * honest refusal/warning stands. Fail-closed by construction.
 */
export async function repairToEvidence(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  deps: AttributedRepairDeps
): Promise<AttributedRepairResult> {
  if (matches.length === 0) {
    return { reason: "no evidence to repair from — honest refusal stands" };
  }
  let rewrite: string;
  try {
    rewrite = (await deps.rewrite({ answer, evidence: formatRepairEvidence(matches), query })).trim();
  } catch {
    return { reason: "repair pass failed — honest refusal stands" };
  }
  if (rewrite.length === 0) {
    return { reason: "empty rewrite — honest refusal stands" };
  }
  const gated = deps.gate ? deps.gate(rewrite) : rewrite;
  if (deps.isRefusal?.(gated) === true) {
    return { reason: "evidence does not support an answer — honest refusal stands" };
  }
  let verification: GroundingVerification;
  try {
    verification = await deps.verify(gated, matches, query);
  } catch {
    // The verifier itself errored (the reverify judge is a model call and can
    // throw). "Fail-closed by construction" must cover this too: a repair we
    // cannot verify is never shown — the honest refusal stands.
    return { reason: "rewrite verification failed — dropped (fail-closed)" };
  }
  if (verification.verdict !== "grounded") {
    return { reason: `rewrite re-verified ${verification.verdict} — dropped (fail-closed)` };
  }
  return { reason: "rewrite verified grounded", repaired: gated };
}
