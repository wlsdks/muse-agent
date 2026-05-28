/**
 * Session-end skill review (fork-and-review, after Hermes Agent).
 * Deterministic detection of which turns warrant authoring a reusable
 * SKILL, then ONE local-model generalisation per candidate. Slice 1
 * handles user corrections; the signal union leaves a seam for
 * complex-success in a later slice. Detection is a rule pass (a small
 * local model is an unreliable self-verifier, arXiv 2404.17140); only
 * generalisation uses the model.
 */

import { detectCorrections, type CorrectionExchange } from "./correction-distiller.js";
import type { SessionTurnLine } from "./episodic-summariser.js";

export type SkillReviewSignal = { readonly kind: "correction"; readonly exchange: CorrectionExchange };

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface DetectSkillCandidatesOptions {
  readonly maxCandidates?: number;
}

export function detectSkillCandidates(
  turns: readonly SessionTurnLine[],
  options?: DetectSkillCandidatesOptions
): readonly SkillReviewSignal[] {
  const max = Math.max(1, Math.trunc(options?.maxCandidates ?? 2));
  return detectCorrections(turns, { maxExchanges: max }).map((exchange) => ({ exchange, kind: "correction" as const }));
}
