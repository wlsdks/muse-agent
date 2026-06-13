/**
 * Cheap semantic pre-filter for per-claim grounding (MiniCheck, arXiv:2404.10774,
 * Tang/Laban/Durrett, EMNLP 2024): embed each claim against the evidence corpus
 * and flag claims whose max cosine falls below a floor as SUSPECT. Only suspect
 * claims need an LLM judge — claims with strong semantic overlap are kept without
 * a model call, making per-claim fact-checking cheap enough to run on every answer.
 */

import { cosineSimilarity } from "./episodic-recall.js";

export interface ClaimSupportScreen {
  readonly claim: string;
  readonly maxCosine: number;
  readonly suspect: boolean;
}

/**
 * Claim↔evidence cosine floor for the semantic pre-filter.
 * 0.45 is below the typical answer↔evidence threshold (~0.55) because a
 * claim is a short sentence and evidence is a longer passage — the embedder
 * averages over more tokens, depressing peak similarity. This value was
 * chosen conservatively to minimise false-suspect (false drops) at the cost
 * of more judge calls on borderline claims; live-tune against real usage
 * (backlog: add a calibration eval over a labelled claim↔evidence set).
 */
export const DEFAULT_CLAIM_SUPPORT_FLOOR = 0.45;

/**
 * Screen each claim against the evidence corpus by semantic cosine similarity
 * (MiniCheck, arXiv:2404.10774). Returns a result per claim with its max cosine
 * over all evidence texts and a `suspect` flag (true = send to the LLM judge).
 *
 * FAIL-OPEN: any embed error marks all claims suspect:false (treat as supported)
 * so a broken embedder never manufactures a refusal. No evidence → suspect:false
 * (can't screen → defer to status quo per-claim behaviour).
 */
export async function screenClaimsBySemanticSupport(
  claims: readonly string[],
  evidence: readonly string[],
  embed: (t: string) => Promise<readonly number[]>,
  floor?: number
): Promise<readonly ClaimSupportScreen[]> {
  if (claims.length === 0) return [];
  const threshold = floor ?? DEFAULT_CLAIM_SUPPORT_FLOOR;

  if (evidence.length === 0) {
    return claims.map((claim) => ({ claim, maxCosine: 0, suspect: false }));
  }

  let evidenceVecs: readonly (readonly number[])[];
  try {
    evidenceVecs = await Promise.all(evidence.map((e) => embed(e)));
  } catch {
    return claims.map((claim) => ({ claim, maxCosine: 0, suspect: false }));
  }

  const results: ClaimSupportScreen[] = [];
  for (const claim of claims) {
    let claimVec: readonly number[];
    try {
      claimVec = await embed(claim);
    } catch {
      results.push({ claim, maxCosine: 0, suspect: false });
      continue;
    }
    const maxCosine = Math.max(...evidenceVecs.map((ev) => cosineSimilarity(claimVec, ev)));
    results.push({ claim, maxCosine, suspect: maxCosine < threshold });
  }
  return results;
}
