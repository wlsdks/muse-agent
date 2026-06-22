/**
 * Citation provenance + source-trust segregation: parse the `[from <source>]`
 * tokens an answer makes, and decide whether a grounded answer rests only on
 * UNTRUSTED evidence (tool/MCP output) so the caller can flag it.
 */

import type { KnowledgeMatch } from "./knowledge-ranking.js";

export const CITATION_RE = /\[from\s+([^\]]+?)\s*\]/giu;

/** Every source the text cites via a `[from <source>]` token, trimmed, in order. */
export function citedSourcesIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const src = match[1]?.trim();
    if (src) out.push(src);
  }
  return out;
}

/**
 * Per-source trust verdict: a source is TRUSTED only when EVERY match for it is
 * trusted (no entry `trusted:false`). Once-poisoned ⇒ poisoned — so a DUPLICATE
 * match for the same source that lacks the bit (e.g. a cited chunk the pre-retrieval
 * top-K missed, appended by `augmentNoteEvidenceWithCited`) can NOT overwrite a base
 * `trusted:false` and silently clear the untrusted-source cue (a naive
 * `new Map(matches.map(...))` keeps the LAST value, which lost that bit). For
 * distinct (non-duplicated) sources this is identical to the per-match check, so
 * existing single-source behaviour is unchanged. Keyed by trimmed-lowercased source.
 */
export function trustBySourceMap(matches: readonly KnowledgeMatch[]): Map<string, boolean> {
  const trust = new Map<string, boolean>();
  for (const m of matches) {
    const key = m.source.trim().toLowerCase();
    trust.set(key, (trust.get(key) ?? true) && m.trusted !== false);
  }
  return trust;
}

/**
 * grounded≠true MITIGATION (source-trust segregation). A grounded answer can be
 * perfectly faithful to its source yet the source itself be UNTRUSTED. Source
 * VERACITY is unknowable on a fixed local model; source TRUST is a known
 * provenance bit (`KnowledgeMatch.trusted`). Returns `true` when EVERY citation in
 * the answer that resolves to a retrieved match resolves ONLY to untrusted ones —
 * i.e. the user is being handed a grounded claim resting entirely on data that is
 * not their own (e.g. MCP tool-output). A single trusted backing source makes it
 * `false`. The caller surfaces a distinct marker so the user applies extra scrutiny.
 * Unresolved citations are NOT this function's concern — verifyGrounding already
 * rejects a fabricated citation as ungrounded.
 */
export function groundedOnUntrustedOnly(answer: string, matches: readonly KnowledgeMatch[]): boolean {
  const cited = citedSourcesIn(answer);
  if (cited.length === 0) {
    return false;
  }
  const trustBySource = trustBySourceMap(matches);
  let anyResolved = false;
  for (const src of cited) {
    const trusted = trustBySource.get(src.trim().toLowerCase());
    if (trusted === undefined) {
      continue;
    }
    anyResolved = true;
    if (trusted) {
      return false;
    }
  }
  return anyResolved;
}

/**
 * Deterministic STRUCTURAL dual of {@link groundedOnUntrustedOnly}: `true` when the
 * EVIDENCE POOL itself is non-empty and entirely untrusted (every match
 * `trusted === false` — MCP/web tool output). A grounded answer drawn from such a
 * pool rests on tool-fetched data no matter whether the model emitted a `[from
 * <source>]` citation, so the untrusted-source notice fires even when the local 8B
 * SKIPS citing (the citation-based check returns `false` on `cited.length === 0`,
 * which a non-citing-but-grounded answer trips — `verifyGrounding` accepts
 * `citationValidity === 1` for zero citations). A single trusted note in the pool
 * makes it `false` (the mixed case is the per-claim guard's concern, not this one).
 * Pure.
 */
export function evidenceIsUntrustedOnly(matches: readonly KnowledgeMatch[]): boolean {
  // Dedup by source (untrusted if ANY entry for the source is trusted:false) so an
  // untagged DUPLICATE of an untrusted source — e.g. an augmented cited chunk —
  // can't break the all-untrusted check; a single genuinely-trusted source still
  // makes it false (mixed is the per-claim guard's concern). Distinct-source pools
  // behave exactly as the prior `every(trusted===false)`.
  const trust = trustBySourceMap(matches);
  return trust.size > 0 && [...trust.values()].every((trusted) => trusted === false);
}

export interface CitationEnforcement {
  /** The answer with every invented `[from <source>]` citation removed. */
  readonly text: string;
  /** The invented sources that were stripped — cited but not among the real ones shown. */
  readonly stripped: readonly string[];
}

export interface AllowedCitations {
  /** `[from <source>]` — note files; exact match (filenames are identifiers). */
  readonly notes?: readonly string[];
  /** `[feed: <name>]` — subscribed feeds; exact match. */
  readonly feeds?: readonly string[];
  /** `[task: <title>]` — open tasks; content-token overlap (the model may reword the title). */
  readonly tasks?: readonly string[];
  /** `[event: <title>]` — upcoming events; content-token overlap. */
  readonly events?: readonly string[];
  /** `[reminder: <text>]` — pending reminders; content-token overlap. */
  readonly reminders?: readonly string[];
  /** `[session: <summary>]` — retrieved past-session summaries; content-token overlap (the model rewrites the recap). */
  readonly sessions?: readonly string[];
  /** `[contact: <name>]` — known contacts; content-token overlap (the model may cite a first name / partial). */
  readonly contacts?: readonly string[];
  /** `[command: <cmd>]` — shell-history commands shown this turn; content-token overlap. */
  readonly commands?: readonly string[];
  /** `[commit: <subject>]` — git commit subjects shown this turn; content-token overlap. */
  readonly commits?: readonly string[];
  /** `[memory: <topic>]` — facts the user told Muse to remember; content-token overlap. */
  readonly memories?: readonly string[];
  /** `[action: <what>]` — actions Muse logged taking on the user's behalf; content-token overlap. */
  readonly actions?: readonly string[];
}
