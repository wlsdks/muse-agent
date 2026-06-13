import { type KnowledgeMatch } from "./knowledge-recall.js";
import { splitPreservingSentencePunctuation } from "./internals.js";

/**
 * grounded≠true per-claim PROVENANCE guard. `groundedOnUntrustedOnly` is a
 * WHOLE-ANSWER marker — its docstring states a single trusted citation makes it
 * `false`. So a MIXED-trust answer (a trivial trusted citation + a load-bearing
 * poisoned UNTRUSTED one, e.g. an MCP/web/tool result) is handed over as plain
 * grounded, with the untrusted claim carrying no scrutiny cue. This is the
 * per-sentence dual: it returns each sentence whose every RESOLVING citation is
 * untrusted (a trusted co-citation on the same sentence clears it). Source
 * VERACITY is unknowable on a fixed local model; source TRUST is the known
 * `KnowledgeMatch.trusted` provenance bit. Diagnostic — changes no gate verdict.
 * Pure. Mirrors `reportCitationPrecision`'s sentinel/split (ALCE arXiv:2305.14627).
 */
const CITATION_FROM_RE = /\[from\s+([^\]]+?)\s*\]/giu;
// Private-use sentinel so a `[from x.md]` marker's internal "." can't split a
// sentence; the sentinel index is stripped before reading the sentence text.
const SENTINEL = "\u{E000}";
const SENTINEL_RE = /\u{E000}(\d+)\u{E000}/gu;

export function untrustedOnlySentences(
  answer: string,
  matches: readonly KnowledgeMatch[]
): readonly string[] {
  const trustBySource = new Map(matches.map((m) => [m.source.trim().toLowerCase(), m.trusted !== false]));

  const citedSources: string[] = [];
  const masked = answer.replace(CITATION_FROM_RE, (_m, src: string) => {
    citedSources.push(src.trim());
    return ` ${SENTINEL}${(citedSources.length - 1).toString()}${SENTINEL} `;
  });

  const flagged: string[] = [];
  for (const sentenceMasked of splitPreservingSentencePunctuation(masked)) {
    const indices = [...sentenceMasked.matchAll(SENTINEL_RE)].map((m) => Number(m[1]));
    if (indices.length === 0) continue;
    let anyResolved = false;
    let anyTrusted = false;
    for (const index of indices) {
      const trusted = trustBySource.get(citedSources[index]!.trim().toLowerCase());
      if (trusted === undefined) continue; // unresolved citation — verifyGrounding's concern, not this guard's
      anyResolved = true;
      if (trusted) anyTrusted = true;
    }
    if (anyResolved && !anyTrusted) {
      flagged.push(sentenceMasked.replace(SENTINEL_RE, " ").replace(/\s+/gu, " ").trim());
    }
  }
  return flagged;
}
