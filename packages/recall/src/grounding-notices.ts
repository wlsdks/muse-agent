import {
  groundedOnUntrustedOnly,
  reportCitationPrecision,
  reportCitationRecall,
  untrustedOnlySentences,
  type KnowledgeMatch
} from "@muse/agent-core";

/**
 * grounded≠true SOURCE-TRUST marker. Distinct from `groundingVerdictNotice`,
 * which flags an UNGROUNDED answer: this fires on a GROUNDED (faithful) answer
 * whose every resolving citation points ONLY at untrusted provenance (MCP/web
 * tool output, `trusted:false`). Source veracity is unknowable on a fixed local
 * model, so we surface the untrusted-only provenance as a scrutiny cue rather
 * than letting a poisonable tool-fetched claim be handed over as plain "grounded".
 * A single trusted backing source clears it (see `groundedOnUntrustedOnly`).
 */
export function untrustedOnlyGroundingNotice(
  answer: string,
  matches: readonly KnowledgeMatch[]
): string | undefined {
  if (groundedOnUntrustedOnly(answer, matches)) {
    return `\n⚠️  Source check: this answer is faithful to its sources, but rests ONLY on tool-fetched data (not your own notes) — verify before trusting.\n`;
  }
  // Per-claim provenance: the whole-answer gate clears when ANY citation is
  // trusted, but a MIXED answer can still rest a specific claim solely on a
  // poisonable tool-fetched source. Surface that claim (grounded≠true).
  const untrusted = untrustedOnlySentences(answer, matches);
  if (untrusted.length > 0) {
    return `\n⚠️  Source check: one claim rests only on tool-fetched data (not your own notes) — verify: "${untrusted[0]}"\n`;
  }
  return undefined;
}

/**
 * ALCE citation-precision cue (arXiv:2305.14627): a sentence can carry a `[from
 * <source>]` citation that RESOLVES to a real retrieved note yet that note not
 * actually support the sentence's claim (right source, wrong claim) — which the
 * whole-answer verdict can miss. Surface the specific mis-cited claim. Fires only
 * on a per-citation support miss (precision < 1); undefined otherwise.
 */
export function citationPrecisionNotice(
  answer: string,
  matches: readonly KnowledgeMatch[]
): string | undefined {
  const report = reportCitationPrecision(answer, matches);
  const sentence = report.unsupported[0];
  if (sentence === undefined) return undefined;
  const shown = sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence;
  return `\n⚠️  Citation check: a cited source doesn't actually support "${shown}" — verify the citation.\n`;
}

/**
 * ALCE citation-RECALL cue (arXiv:2305.14627), the complement to the precision
 * cue: a sentence whose claim IS in the retrieved evidence but that omits its
 * `[from <source>]` marker — a groundable claim handed over with no attribution.
 * Surfaces the first such missing-citation claim. Undefined when every citable
 * sentence is cited.
 */
export function citationRecallNotice(
  answer: string,
  matches: readonly KnowledgeMatch[]
): string | undefined {
  const report = reportCitationRecall(answer, matches);
  const sentence = report.uncited[0];
  if (sentence === undefined) return undefined;
  const shown = sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence;
  return `\n⚠️  Attribution check: "${shown}" matches your notes but carries no citation — its source isn't shown.\n`;
}
