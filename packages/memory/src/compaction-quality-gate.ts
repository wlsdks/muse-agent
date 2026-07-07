/**
 * Fail-close quality gate for the CMP-2 auxiliary-model compaction summary
 * (hermes/openclaw-inspired post-compaction safeguard, adapted to Muse's
 * deterministic-gate style — the gate is CODE, never a second model call).
 *
 * The deterministic `[Key details]` block (salient-facts.ts) is already the
 * unconditional floor for every compaction. This gate protects the OPTIONAL
 * layer on top of it: the aux LLM's free-text recap
 * (`summarizeDroppedContext` / `createModelDroppedContextSummarizer`), which
 * — being generated prose — can omit or garble a hard fact the deterministic
 * extractor would have kept verbatim. Before that recap is appended to the
 * conversation, `verifyCompactionSummaryQuality` re-derives the same "hard
 * anchors" (numbers/dates/amounts, quoted/proper-noun-ish tokens, code
 * identifiers, decision lines) from the turns being dropped and checks the
 * recap actually mentions enough of them. A summary a user's own words
 * asserted anchors around must ALWAYS be represented — user-stated facts
 * outrank assistant chatter, so those are required at 100%, never just the
 * overall ratio.
 *
 * Reuses `extractSalientFacts` (numeric/decision/entity extraction,
 * verbatim-substring only) rather than re-deriving that logic — this module
 * only adds the anchor families that extractor doesn't already cover:
 * bare capitalized words, code identifiers, ISO/slash dates, and Korean
 * number+classifier phrases (년/월/일 are already covered via
 * `extractSalientFacts`'s Korean unit run; `3동`/`5층`-style classifiers are
 * not, and are added here).
 *
 * Two match modes, not one: a NUMERIC/ENTITY/quoted/code-identifier anchor is
 * a short atomic token a faithful summary should reproduce VERBATIM, so it's
 * matched by exact substring. A DECISION anchor (reused from
 * `extractSalientFacts`) is often a WHOLE SENTENCE — a real aux summarizer
 * legitimately paraphrases it (that's the entire point of summarizing), so
 * requiring the exact sentence as a substring would fail almost every honest
 * summary. Those anchors are matched by significant-word overlap instead
 * (still deterministic string work, no LLM) — a real paraphrase covers most
 * of the sentence's content words; a summary that dropped the fact entirely
 * won't.
 */
import type { ConversationMessage } from "./index.js";
import { extractSalientFacts } from "./salient-facts.js";

export const DEFAULT_ANCHOR_COVERAGE_RATIO = 0.6;

// A DECISION anchor counts as covered when at least this fraction of its
// significant (4+ char) words appear in the summary — see the module doc.
const DECISION_WORD_OVERLAP_RATIO = 0.5;

export interface CompactionAnchor {
  /** Verbatim substring of a dropped message that the summary should preserve. */
  readonly value: string;
  /** True when this anchor was asserted in a USER message (must always survive). */
  readonly userAsserted: boolean;
  /**
   * True for a long decision SENTENCE, matched by significant-word overlap
   * rather than exact substring (see module doc). False for a short atomic
   * token (number/date/quoted string/identifier) matched verbatim.
   */
  readonly fuzzy: boolean;
}

export interface CompactionQualityGateOptions {
  /** Minimum fraction of ALL anchors the summary must cover. Default 0.6. */
  readonly minCoverageRatio?: number;
}

export interface CompactionQualityGateResult {
  readonly passed: boolean;
  readonly coverageRatio: number;
  readonly totalAnchors: number;
  readonly coveredAnchors: number;
  /** User-asserted anchors the summary is missing — non-empty ⇒ automatic fail. */
  readonly missingUserAnchors: readonly string[];
}

// Bare capitalized English word — a light proper-noun heuristic. This is a
// HEURISTIC, not an NER model: it will miss lowercase names, and a
// capitalized word that is the FIRST word of a message is excluded (ordinary
// sentence-initial capitalization — "Quick update: …" — is not a proper
// noun) rather than maintained as an ever-growing stopword list. It will
// still occasionally flag a genuine capitalized non-name later in a
// sentence; tests document both limits.
const BARE_CAPITALIZED_WORD = /\b[A-Z][a-z]{2,}\b/gu;

// Code identifiers: snake_case (at least one underscore) or camelCase
// (lowercase start, at least one internal capital).
const CODE_IDENTIFIER =
  /\b[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+\b|\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/gu;

// ISO (2026-07-07) and slash (7/7/2026, 7/7) dates. Korean dates
// (10월 3일) are already covered by extractSalientFacts's NUMERIC pattern.
const DATE_PATTERN = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gu;

// Korean number+classifier phrases NOT already covered by extractSalientFacts's
// unit run (천만억조원명개시분일월년%) — building/floor/ticket-style counters
// like `3동`, `5층`, `2번`. Allowlisted to a single classifier char (rather
// than "any following hangul run") so a trailing particle/copula
// (`5층이야` → "이야") isn't swallowed into the anchor.
const HANGUL_COUNTER = /\d+(?:동|층|번|호|대|차|회|반|채|칸|급|기)/gu;

function extractSupplementaryAnchors(text: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    if (value.length > 0 && !seen.has(value)) {
      seen.add(value);
      found.push(value);
    }
  };
  for (const match of text.matchAll(BARE_CAPITALIZED_WORD)) {
    const startsAtMessage = text.slice(0, match.index ?? 0).trim().length === 0;
    if (!startsAtMessage) add(match[0]);
  }
  for (const match of text.matchAll(CODE_IDENTIFIER)) add(match[0]);
  for (const match of text.matchAll(DATE_PATTERN)) add(match[0]);
  for (const match of text.matchAll(HANGUL_COUNTER)) add(match[0]);
  return found;
}

/**
 * Extract the "hard anchors" a compaction summary of `messages` must
 * preserve: verbatim numbers/dates/amounts, decision lines, and
 * proper-noun-ish tokens (quoted strings, issue keys, code identifiers,
 * capitalized words, Korean number+classifier phrases). tool-role turns are
 * excluded (trust boundary, matching `extractSalientFacts`).
 */
export function extractCompactionAnchors(
  messages: readonly ConversationMessage[]
): readonly CompactionAnchor[] {
  const userMessages = messages.filter((message) => message.role === "user");
  const userValues = new Set<string>(extractSalientFacts(userMessages).map((fact) => fact.value));
  for (const message of userMessages) {
    for (const value of extractSupplementaryAnchors(message.content)) userValues.add(value);
  }

  const anchors = new Map<string, { userAsserted: boolean; fuzzy: boolean }>();
  for (const fact of extractSalientFacts(messages)) {
    anchors.set(fact.value, { fuzzy: fact.category === "DECISION", userAsserted: userValues.has(fact.value) });
  }
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const value of extractSupplementaryAnchors(message.content)) {
      const existing = anchors.get(value);
      anchors.set(value, { fuzzy: false, userAsserted: existing?.userAsserted === true || userValues.has(value) });
    }
  }

  return [...anchors.entries()].map(([value, meta]) => ({ value, ...meta }));
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

// Significant (content-bearing) words: 4+ chars, lowercased, deduped —
// used only for fuzzy (decision-sentence) matching.
function significantWords(text: string): readonly string[] {
  const words = normalize(text).match(/\p{L}[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(words)];
}

function isCovered(anchor: CompactionAnchor, normalizedSummary: string): boolean {
  if (!anchor.fuzzy) {
    return normalizedSummary.includes(normalize(anchor.value));
  }
  const words = significantWords(anchor.value);
  if (words.length === 0) {
    return normalizedSummary.includes(normalize(anchor.value));
  }
  const present = words.filter((word) => normalizedSummary.includes(word));
  return present.length / words.length >= DECISION_WORD_OVERLAP_RATIO;
}

/**
 * Fail-close gate: verify a generated `summaryText` preserves enough of the
 * hard anchors from the `dropped` turns it replaces. No LLM call — pure
 * string matching against `extractCompactionAnchors`'s output. Passes
 * vacuously (no anchors to lose) when `dropped` yields none.
 */
export function verifyCompactionSummaryQuality(
  dropped: readonly ConversationMessage[],
  summaryText: string,
  options: CompactionQualityGateOptions = {}
): CompactionQualityGateResult {
  const minCoverageRatio = options.minCoverageRatio ?? DEFAULT_ANCHOR_COVERAGE_RATIO;
  const anchors = extractCompactionAnchors(dropped);

  if (anchors.length === 0) {
    return { coverageRatio: 1, coveredAnchors: 0, missingUserAnchors: [], passed: true, totalAnchors: 0 };
  }

  const normalizedSummary = normalize(summaryText);
  const covered = anchors.filter((anchor) => isCovered(anchor, normalizedSummary));
  const coveredSet = new Set(covered);
  const missingUserAnchors = anchors
    .filter((anchor) => anchor.userAsserted && !coveredSet.has(anchor))
    .map((anchor) => anchor.value);
  const coverageRatio = covered.length / anchors.length;
  const passed = coverageRatio >= minCoverageRatio && missingUserAnchors.length === 0;

  return { coverageRatio, coveredAnchors: covered.length, missingUserAnchors, passed, totalAnchors: anchors.length };
}
