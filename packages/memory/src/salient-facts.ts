/**
 * Deterministic salient-fact extractor for conversation compaction.
 *
 * Grounded in the non-compressive detail-retention principle from
 * arXiv:2511.17208 (Zhou & Han, UIUC, 2025 — "A Simple Yet Strong Baseline
 * for Long-Term Conversational Memory of LLM Agents"): verbatim user-stated
 * details (numbers, amounts, decisions) must survive compaction so downstream
 * consumers can reason over them exactly as stated.
 *
 * All extracted values are VERBATIM SUBSTRINGS of the source message — regex
 * selection only, never generation or paraphrase. Extracts from role:"user"
 * and role:"assistant" turns only; role:"tool" is excluded (untrusted,
 * trust-boundary).
 */

import type { ConversationMessage, FactCategory, StructuredFact } from "./index.js";
import { normalizeMemoryKey } from "./memory-user-store.js";
import { extractPinnedEntities } from "./pinned-entities.js";

// Maximal Korean scale/unit suffix — one contiguous run so `5천만원` (50M)
// is captured whole rather than truncating at the first matched scale char.
// Includes simple units (명·개·시·분·일·월·년) and percent.
const KO_UNIT_RUN = /[천만억조원명개시분일월년%]+/u;

// NUMERIC: number + maximal unit suffix. Uses KO_UNIT_RUN.source so the
// scale chars are never individually alternated (which would cause `천`
// to win over `천만원`). Latin units (달러/개월/시간/USD/…) still listed
// explicitly because they don't compose like KO scale chars.
const NUMERIC_PATTERN = new RegExp(
  `(?<phrase>-?(?:[\\d][\\d,.]*[\\d]|[\\d])` +
    `(?:\\s*[-~]\\s*(?:[\\d][\\d,.]*[\\d]|[\\d]))?` +
    `\\s*(?:${KO_UNIT_RUN.source}|개월|시간|달러|USD|KRW|EUR|GBP|JPY|%))`,
  "gu"
);

// Currency-symbol prefix form: captures complete numbers including dot-grouped
// (₩1.250.000), comma-grouped ($9,999), and ranges ($3-4 million).
const CURRENCY_SYMBOL_PATTERN =
  /(?<phrase>[₩$€£¥]\s*(?:[\d][\d,.]*[\d]|[\d])(?:\s*[-~]\s*(?:[\d][\d,.]*[\d]|[\d]))?(?:\s+(?:million|billion|trillion|thousand|만|억|천))?)/gu;

// Chars that, if adjacent to a matched phrase, indicate truncation.
const SCALE_UNIT_CHARS = new Set([..."천만억조원명개시분일월년%", ",", "."]);

// Sino-Korean numerals that can begin a hangul-numeral compound segment
// (e.g. `오천만원`, `천만원`, `만원`) — needed for the spaced-compound guard.
const HANGUL_NUMERAL_RE = /[영일이삼사오육칠팔구십백천만억조]/u;

// Complete "numeric continuation" set for across-whitespace guards:
// a char is CONT if it is a digit, grouping punct, scale/unit, or Sino-Korean numeral.
function isCont(ch: string): boolean {
  return /\d/u.test(ch) || SCALE_UNIT_CHARS.has(ch) || HANGUL_NUMERAL_RE.test(ch);
}

/**
 * Return true when the phrase is a COMPLETE token in `source` at `offset`.
 * Guards applied symmetrically on all four directions:
 *   1. char immediately BEFORE ∈ CONT → drop (leading context)
 *   2. char immediately AFTER ∈ CONT → drop (trailing context)
 *   3. skip spaces FORWARD; next non-space ∈ CONT → drop (spaced-compound tail)
 *   4. skip spaces BACKWARD; prev non-space ∈ CONT → drop (spaced-compound head)
 * Any emitted token therefore has non-CONT context on both sides — it is a
 * maximal complete amount.
 */
function isCompleteToken(source: string, offset: number, phrase: string): boolean {
  const before = offset > 0 ? source[offset - 1] : "";
  const afterIdx = offset + phrase.length;
  const after = afterIdx < source.length ? source[afterIdx] : "";

  if (before && isCont(before)) return false;
  if (after && isCont(after)) return false;

  // Forward spaced-compound: skip any whitespace after match; CONT char follows → drop.
  let fwd = afterIdx;
  while (fwd < source.length && /\s/u.test(source[fwd]!)) fwd++;
  if (fwd < source.length && isCont(source[fwd]!)) return false;

  // Backward spaced-compound: skip any whitespace before match start; CONT char
  // precedes → this token is a second segment of a larger amount → drop.
  let bwd = offset - 1;
  while (bwd >= 0 && /\s/u.test(source[bwd]!)) bwd--;
  if (bwd >= 0 && isCont(source[bwd]!)) return false;

  return true;
}

// DECISION: lines containing commitment / decision markers (KO + EN).
const DECISION_PATTERN =
  /[^\n]*(?:하기로|결정(?:했|했다|하다)|확정(?:됐|됐다|하다|하다)?|decided\s+to|agreed\s+to|let'?s\s+go\s+with|we(?:'ll|\s+will)\s+)[^\n]*/giu;

const MAX_NUMERIC_PER_ROUND = 4;
const MAX_DECISION_PER_ROUND = 3;
const MAX_ENTITY_PER_ROUND = 5;
const GLOBAL_CAP = 12;
const MAX_VALUE_CHARS = 140;
const MAX_KEY_CHARS = 60;

// Returns null when the cleaned value exceeds MAX_VALUE_CHARS \u2014 drop-if-over-cap.
// A mid-sentence slice can invert meaning (verb-final languages put negation/
// qualifier at the end); omission is always floor-safe, truncation is not.
function sanitizeValue(raw: string): string | null {
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length > MAX_VALUE_CHARS) return null;
  return cleaned;
}

function sanitizeKey(raw: string): string {
  return normalizeMemoryKey(raw).slice(0, MAX_KEY_CHARS) || "fact";
}

/**
 * Extract verbatim numeric phrases from a single text body.
 * Returns at most `MAX_NUMERIC_PER_ROUND` facts per call.
 */
function extractNumericFacts(text: string): StructuredFact[] {
  const seen = new Set<string>();
  const facts: StructuredFact[] = [];

  // Currency-symbol form: $9,999 / ₩1,250,000
  for (const match of text.matchAll(CURRENCY_SYMBOL_PATTERN)) {
    const phrase = match.groups?.phrase?.trim() ?? "";
    if (!phrase || seen.has(phrase)) continue;
    const offset = match.index ?? 0;
    if (!isCompleteToken(text, offset, match[0] ?? "")) continue;
    const value = sanitizeValue(phrase);
    if (!value) continue;
    seen.add(phrase);
    const key = sanitizeKey(phrase.replace(/[^\p{L}\p{N}]/gu, "_"));
    facts.push({ category: "NUMERIC", key, value });
    if (facts.length >= MAX_NUMERIC_PER_ROUND) break;
  }

  if (facts.length >= MAX_NUMERIC_PER_ROUND) return facts;

  // Korean + general unit form
  for (const match of text.matchAll(NUMERIC_PATTERN)) {
    const phrase = match.groups?.phrase?.trim() ?? "";
    if (!phrase || seen.has(phrase)) continue;
    const offset = match.index ?? 0;
    if (!isCompleteToken(text, offset, match[0] ?? "")) continue;
    const value = sanitizeValue(phrase);
    if (!value) continue;
    seen.add(phrase);
    const key = sanitizeKey(phrase.replace(/[^\p{L}\p{N}]/gu, "_"));
    facts.push({ category: "NUMERIC", key, value });
    if (facts.length >= MAX_NUMERIC_PER_ROUND) break;
  }

  return facts;
}

/**
 * Extract decision lines from a single text body.
 */
function extractDecisionFacts(text: string): StructuredFact[] {
  const facts: StructuredFact[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(DECISION_PATTERN)) {
    const line = match[0]?.trim() ?? "";
    const value = sanitizeValue(line);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const key = sanitizeKey(value.slice(0, 40));
    facts.push({ category: "DECISION", key, value });
    if (facts.length >= MAX_DECISION_PER_ROUND) break;
  }

  return facts;
}

/**
 * Extract salient facts from a conversation (user + assistant turns only).
 *
 * Values are verbatim substrings of source messages. tool-role messages are
 * excluded at the trust boundary.
 *
 * Grounded in arXiv:2511.17208 non-compressive detail-retention: numbers,
 * amounts, and decisions must survive compaction unchanged.
 */
export function extractSalientFacts(messages: readonly ConversationMessage[]): StructuredFact[] {
  const numericFacts: StructuredFact[] = [];
  const decisionFacts: StructuredFact[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue; // trust boundary: skip tool turns
    }
    const text = message.content;
    if (!text) continue;

    if (numericFacts.length < MAX_NUMERIC_PER_ROUND) {
      for (const fact of extractNumericFacts(text)) {
        if (numericFacts.length >= MAX_NUMERIC_PER_ROUND) break;
        numericFacts.push(fact);
      }
    }

    if (decisionFacts.length < MAX_DECISION_PER_ROUND) {
      for (const fact of extractDecisionFacts(text)) {
        if (decisionFacts.length >= MAX_DECISION_PER_ROUND) break;
        decisionFacts.push(fact);
      }
    }
  }

  // Entity facts: reuse extractPinnedEntities (user-only filter is
  // already inside that function).
  const entityStrings = extractPinnedEntities(messages);
  const entityFacts: StructuredFact[] = entityStrings
    .slice(0, MAX_ENTITY_PER_ROUND)
    .flatMap((entity) => {
      const value = sanitizeValue(entity);
      if (!value) return [];
      return [{ category: "ENTITY" as FactCategory, key: sanitizeKey(entity), value }];
    });

  const all = [...numericFacts, ...decisionFacts, ...entityFacts];

  // Dedupe by normalized key — keep first occurrence (they arrive newest-
  // round first from the caller's perspective).
  const seen = new Set<string>();
  return all.filter((fact) => {
    if (seen.has(fact.key)) return false;
    seen.add(fact.key);
    return true;
  });
}

/**
 * Merge two arrays of structured facts: newest-wins per normalized key,
 * evict oldest entries when over `cap`. Never deletes keys that aren't
 * superseded or over-cap.
 */
export function mergeSalientFacts(
  previous: readonly StructuredFact[],
  fresh: readonly StructuredFact[],
  cap = GLOBAL_CAP
): StructuredFact[] {
  // Build a map keyed by normalized key; fresh wins over previous.
  const merged = new Map<string, StructuredFact>();

  // Previous first (older), then fresh (newer) — newer overwrites older.
  for (const fact of [...previous, ...fresh]) {
    const key = normalizeMemoryKey(fact.key);
    merged.set(key, { ...fact, key });
  }

  const entries = [...merged.values()];

  // Cap: evict oldest (first-inserted = previous entries that aren't in fresh).
  // The Map preserves insertion order; fresh entries are at the end, so
  // slicing from the END preserves the newest `cap` facts.
  if (entries.length > cap) {
    return entries.slice(entries.length - cap);
  }

  return entries;
}

const KEY_DETAILS_HEADER = "[Key details]";
const FACT_LINE_RE = /^•\s+\[(?<cat>[A-Z]+)\]\s+(?<key>[^:]+):\s+(?<value>.+)$/u;

/**
 * Render structured facts into a `[Key details]` block for embedding in
 * compaction summaries. Format: one bullet per fact.
 */
export function renderKeyDetailsBlock(facts: readonly StructuredFact[]): string {
  if (facts.length === 0) return "";
  const lines = [KEY_DETAILS_HEADER];
  for (const fact of facts) {
    lines.push(`• [${fact.category ?? "GENERAL"}] ${fact.key}: ${fact.value}`);
  }
  return lines.join("\n");
}

/**
 * Parse a `[Key details]` block back into StructuredFact[].
 * Returns [] on malformed input (fail-open).
 */
export function parseKeyDetailsBlock(text: string): StructuredFact[] {
  const facts: StructuredFact[] = [];
  const headerIdx = text.indexOf(KEY_DETAILS_HEADER);
  if (headerIdx < 0) return facts;

  const block = text.slice(headerIdx + KEY_DETAILS_HEADER.length);
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("•")) continue;
    const match = FACT_LINE_RE.exec(line);
    if (!match?.groups) continue;
    const { cat, key, value } = match.groups;
    if (!key || !value) continue;
    facts.push({
      category: (cat ?? "GENERAL") as FactCategory,
      key: key.trim(),
      value: value.trim()
    });
  }

  return facts;
}

/**
 * Strip the `[Key details]` block from a summary string so successive
 * compaction rounds don't accumulate duplicates.
 */
export function stripKeyDetailsBlock(summary: string): string {
  const headerIdx = summary.indexOf(KEY_DETAILS_HEADER);
  if (headerIdx < 0) return summary;

  // Find the extent of the block: consume bullet lines after the header.
  const beforeBlock = summary.slice(0, headerIdx).trimEnd();
  const afterHeader = summary.slice(headerIdx + KEY_DETAILS_HEADER.length);
  const lines = afterHeader.split("\n");

  let endOffset = 0;
  for (const line of lines) {
    if (line.trim().startsWith("•") || line.trim() === "") {
      endOffset += line.length + 1; // +1 for \n
    } else {
      break;
    }
  }

  const afterBlock = afterHeader.slice(endOffset).trimStart();
  return afterBlock ? `${beforeBlock}\n${afterBlock}` : beforeBlock;
}
