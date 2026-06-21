import {
  evidenceIsUntrustedOnly,
  groundedOnUntrustedOnly,
  reportCitationPrecision,
  reportCitationRecall,
  untrustedOnlySentences,
  type KnowledgeMatch
} from "@muse/agent-core";

import { answerIsRefusal } from "./text.js";

/**
 * grounded≠true SOURCE-TRUST marker. Distinct from `groundingVerdictNotice`,
 * which flags an UNGROUNDED answer: this fires on a GROUNDED (faithful) answer
 * whose every resolving citation points ONLY at untrusted provenance (MCP/web
 * tool output, `trusted:false`). Source veracity is unknowable on a fixed local
 * model, so we surface the untrusted-only provenance as a scrutiny cue rather
 * than letting a poisonable tool-fetched claim be handed over as plain "grounded".
 * A single trusted backing source clears it (see `groundedOnUntrustedOnly`).
 *
 * Fires on EITHER the citation-based check (`groundedOnUntrustedOnly`, precise per
 * resolving citation) OR the deterministic structural check
 * (`evidenceIsUntrustedOnly` — the whole evidence pool is tool-fetched), so a
 * non-citing but grounded answer still gets the cue (the 8B may skip the `[from
 * <src>]` marker). The caller only invokes this on a GROUNDED answer (post-gate);
 * the empty-answer guard keeps a degenerate direct call from firing on no claim.
 */
export function untrustedOnlyGroundingNotice(
  answer: string,
  matches: readonly KnowledgeMatch[]
): string | undefined {
  if (answer.trim().length === 0 || answerIsRefusal(answer)) return undefined;
  if (groundedOnUntrustedOnly(answer, matches) || evidenceIsUntrustedOnly(matches)) {
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
 * Build a grounding-evidence match for an external FEED headline, tagged
 * `trusted:false`. Feed entries are third-party publisher content (RSS/Atom) —
 * NOT the user's own data — so an answer resting SOLELY on a (poisonable) feed
 * headline must trip the untrusted-only source-check cue, exactly like a web/MCP
 * tool result (the agent-grounding path already tags those `trusted:false`). The
 * user's OWN corpus (notes / memory / tasks / reminders / contacts / past
 * sessions) stays trusted (absent flag) — that data IS theirs, and marking it
 * untrusted would fire the scrutiny cue on the user's own notes. `text` mirrors
 * the ask wedge's inline feed evidence shape exactly (title + optional summary)
 * so only the trust bit changes, not what the grounding gate scores. Pure.
 */
export function untrustedFeedMatch(feedName: string, title: string, summary?: string): KnowledgeMatch {
  return { cosine: 1, score: 1, source: `feed: ${feedName}`, text: summary ? `${title} ${summary}` : title, trusted: false };
}

/** Structured machine-surface twin of the three human source-check cues. */
export interface SourceCheckSignals {
  /** The faithful answer rests ONLY on untrusted (tool/web/MCP/feed) provenance. */
  readonly untrustedOnly: boolean;
  /** A cited source resolves but does not support its sentence (ALCE precision). */
  readonly citationUnsupported: boolean;
  /** A groundable claim is handed over with no `[from …]` attribution (ALCE recall). */
  readonly citationUncited: boolean;
}

/**
 * The MACHINE twin of {@link untrustedOnlyGroundingNotice} /
 * {@link citationPrecisionNotice} / {@link citationRecallNotice}: a `muse ask --json`
 * or run-log consumer (a downstream agent/script) can't read the human stderr cue,
 * so without this it gets a confident `groundedVerdict:"grounded"` with ZERO
 * indication the answer rests only on poisonable sources or carries an unsupported /
 * uncited citation — the same GROUNDED≠TRUE machine-surface leak V1 closed for
 * FAN-OUT signals, here for the SOURCE-CHECK cues (which were stderr-only). Reuses
 * the exact same notice predicates (calls the three notice fns) so the human and
 * machine surfaces can NEVER drift. Returns `undefined` when every check is clean
 * (so the caller emits no key — no `--json` noise on a clean grounded answer). Pure.
 */
export function sourceCheckSignals(
  answer: string,
  matches: readonly KnowledgeMatch[]
): SourceCheckSignals | undefined {
  const untrustedOnly = untrustedOnlyGroundingNotice(answer, matches) !== undefined;
  const citationUnsupported = citationPrecisionNotice(answer, matches) !== undefined;
  const citationUncited = citationRecallNotice(answer, matches) !== undefined;
  return untrustedOnly || citationUnsupported || citationUncited
    ? { untrustedOnly, citationUnsupported, citationUncited }
    : undefined;
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
