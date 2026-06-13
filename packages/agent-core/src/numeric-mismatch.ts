import { lexicalTokens } from "./knowledge-recall.js";

/**
 * Numeric / unit mismatch (FactCC quantity-error class, arXiv:1910.12840; faithfulness
 * survey arXiv:2501.00269). Token coverage treats "5 mg" and "5 g" as both
 * containing the token "5" — the numeral covers, the UNIT swap is invisible — and
 * a magnitude error ("13800" vs "1380") only dents coverage. This flags the two
 * deterministic, low-false-positive cases the lexical gate misses:
 *
 *  (a) UNIT SWAP — the answer's numeral appears in the evidence but with a
 *      DIFFERENT unit (5 g vs 5 mg). High-harm (dosages), unambiguous.
 *  (b) MAGNITUDE / ABSENT — a ≥3-digit answer numeral absent from every evidence
 *      numeral (13800 vs 1380). The ≥3-digit floor avoids word-form small-number
 *      false positives ("3" vs "three"), matching the chat number-guard policy.
 *
 * Pure. Numerals normalized by stripping thousands separators so "1,250,000" ==
 * "1250000". Compared against the UNION of evidence numerals (not per-sentence) so
 * an answer combining facts from several evidence sentences isn't false-flagged.
 */
const NUMBER_UNIT_RE = /(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z%]+)?/gu;

function normalizeNumeral(raw: string): string {
  return raw.replace(/,/gu, "");
}

interface NumberUnit {
  readonly numeral: string;
  readonly unit: string | undefined;
}

function numberUnitsIn(text: string): NumberUnit[] {
  const out: NumberUnit[] = [];
  for (const match of text.matchAll(NUMBER_UNIT_RE)) {
    const numeral = normalizeNumeral(match[1] ?? "");
    if (numeral.length === 0) continue;
    const rawUnit = match[2]?.toLowerCase();
    out.push({ numeral, unit: rawUnit && rawUnit.length > 0 ? rawUnit : undefined });
  }
  return out;
}

export function detectNumericMismatch(sentence: string, evidence: readonly string[]): boolean {
  const answerNumbers = numberUnitsIn(sentence);
  if (answerNumbers.length === 0) return false;
  // Only run when the sentence otherwise overlaps the evidence (same topic) — a
  // numeric answer with no lexical relation to the evidence isn't this guard's job.
  const sentenceTokens = lexicalTokens(sentence);
  const evidenceTokens = new Set<string>();
  const evidenceUnitsByNumeral = new Map<string, Set<string>>();
  const evidenceNumerals = new Set<string>();
  for (const block of evidence) {
    for (const token of lexicalTokens(block)) evidenceTokens.add(token);
    for (const { numeral, unit } of numberUnitsIn(block)) {
      evidenceNumerals.add(numeral);
      if (unit !== undefined) {
        const set = evidenceUnitsByNumeral.get(numeral) ?? new Set<string>();
        set.add(unit);
        evidenceUnitsByNumeral.set(numeral, set);
      }
    }
  }
  let overlap = 0;
  for (const token of sentenceTokens) {
    if (evidenceTokens.has(token)) overlap += 1;
  }
  if (sentenceTokens.size === 0 || overlap / sentenceTokens.size < 0.5) return false;

  for (const { numeral, unit } of answerNumbers) {
    // (a) unit swap: the numeral is in the evidence but its unit there never matches.
    if (unit !== undefined) {
      const units = evidenceUnitsByNumeral.get(numeral);
      if (units !== undefined && units.size > 0 && !units.has(unit)) return true;
    }
    // (b) magnitude / absent: a ≥3-digit numeral the evidence never states.
    if (numeral.replace(/\D/gu, "").length >= 3 && !evidenceNumerals.has(numeral)) return true;
  }
  return false;
}
