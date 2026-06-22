import type { RecallHit } from "./hit.js";
import { renderMemoryFact, type MemoryFact } from "./select.js";

/**
 * A grounded≠true hole the rest of the stack does NOT cover: every gate screens
 * a CLAIM against its EVIDENCE, but nothing screens EVIDENCE against EVIDENCE. So
 * when two retrieved sources give different values for the SAME field (an old vs
 * a new wifi password, two addresses), the answer confidently cites ONE with a
 * clean receipt and the user never learns their own notes disagree. This is the
 * deterministic detector for that case — pure, no model, runnable on the hot path.
 */
export interface SourceConflict {
  /** The normalized labelled field the two sources disagree on (e.g. "wifi password"). */
  readonly field: string;
  readonly a: RecallHit;
  readonly b: RecallHit;
  /** The value `a` gives for the field (original text). */
  readonly valueA: string;
  /** The value `b` gives for the field (original text). */
  readonly valueB: string;
}

/**
 * `label: value` on a line. The label must NOT be preceded by a word char or
 * digit (so a time `9:30` or `http://` never parses as a field) — it starts at a
 * line/space boundary. The value runs to a clause end, now INCLUDING commas; a
 * non-address field's value is truncated at the first comma in `fieldsOf` (see
 * `ADDRESS_LABELS`) so only an address keeps its internal comma.
 */
const LABELLED_VALUE = /(?<![\w:])([\p{L}][\p{L}\p{N} ]{1,40}?):[ \t]*([^\n.;]+)/gu;

/**
 * Labels whose value LEGITIMATELY carries an internal comma (a street address).
 * For these the value spans the comma so `12 Baker St, London` vs `12 Baker St,
 * Paris` is caught as a real conflict (previously both truncated to "12 Baker St"
 * = a missed disagreement). EVERY other field truncates at the first comma so a
 * benign comma LIST (items / tags / attendees / ingredients) can't manufacture a
 * false "your sources disagree" cue — comma-broadening is label-gated, not global.
 */
const ADDRESS_LABELS = new Set(["address", "addr", "addresses", "location", "주소", "주소지", "위치", "소재지", "거주지"]);

/**
 * Common PROSE prefixes that are not real attributes — two notes both opening
 * "Note: ..." / "TODO: ..." with different text are NOT a field disagreement.
 * Excluding them is what keeps the detector from over-firing on ordinary prose
 * (the dominant false-positive class).
 */
const PROSE_LABELS = new Set([
  "note", "notes", "todo", "fyi", "ps", "nb", "summary", "tip", "tips",
  "warning", "caution", "aside", "eg", "ie", "example", "context", "background",
  // Korean prose prefixes — the field regex now parses Hangul labels, so the same
  // over-firing class (two notes both opening "참고: …" with different text) needs
  // the same exclusion the English prefixes get.
  "참고", "참조", "메모", "예시", "요약", "주의", "비고"
]);

/** Normalize a field label for matching: lowercase, collapse whitespace, trim. */
function normalizeField(label: string): string {
  return label.toLowerCase().replace(/\s+/gu, " ").trim();
}

/** A label is a real attribute only if it's not a prose prefix and doesn't end in a digit (a stray time/number). */
function isAttributeLabel(field: string): boolean {
  return !PROSE_LABELS.has(field) && !/\d$/u.test(field);
}

/** Comparison key for a value: lowercase, collapse whitespace, strip wrapping quotes and leading/trailing punctuation. */
function valueKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "")
    .trim();
}

/** The first labelled value per field within one snippet (intra-hit duplicates ignored). */
function fieldsOf(snippet: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of snippet.matchAll(LABELLED_VALUE)) {
    const field = normalizeField(match[1] ?? "");
    const raw = (match[2] ?? "").trim();
    if (field.length === 0 || !isAttributeLabel(field)) continue;
    // Comma-broadening is gated to address-like labels; every other field keeps
    // the historical first-comma-stop so a benign comma list can't conflict.
    const value = ADDRESS_LABELS.has(field) ? raw : (raw.split(",")[0] ?? "").trim();
    if (value.length === 0) continue;
    if (!out.has(field)) out.set(field, value); // first wins — same-hit repeats aren't a cross-source conflict
  }
  return out;
}

/**
 * Compose the answer's grounding (ranked note chunks + past-session episodes)
 * into a source-conflict cue. The caller passes the SAME grounding that backed
 * the answer; a non-undefined return means two of those sources disagree on a
 * field and should be surfaced before the user trusts the answer. Pure.
 */
export function groundingConflictCue(
  notes: ReadonlyArray<{ readonly file: string; readonly text: string }>,
  episodes: ReadonlyArray<{ readonly id: string; readonly summary: string }>,
  memories: readonly MemoryFact[] = []
): string | undefined {
  const hits: RecallHit[] = [
    ...notes.map((n) => ({ ref: n.file, score: 1, snippet: n.text, source: "notes" as const })),
    ...episodes.map((e) => ({ ref: e.id, score: 1, snippet: e.summary, source: "episodes" as const })),
    // Remembered facts are already `key: value`, so renderMemoryFact yields exactly
    // the labelled form the detector compares — a stale memory fact disagreeing with
    // a note (the cross-store grounded≠true hole) now surfaces. A boolean-ish fact
    // renders as the bare topic (no colon) and so carries no comparable field.
    ...memories.map((m) => ({ ref: `memory:${m.key}`, score: 1, snippet: renderMemoryFact(m), source: "memory" as const }))
  ];
  return formatSourceConflictWarning(hits);
}

/**
 * Source-conflict cue from a flat list of grounding matches ({source, text} — the
 * KnowledgeMatch shape the chat path carries). Maps them to hits and runs the
 * hardened detector; non-undefined means two of the user's own grounded sources
 * disagree. Pure. (The ask path uses `groundingConflictCue`; this is its chat-side
 * sibling for the already-flat match list.)
 */
export function conflictCueFromMatches(
  matches: ReadonlyArray<{ readonly source: string; readonly text: string }>,
  memories: readonly MemoryFact[] = []
): string | undefined {
  return formatSourceConflictWarning([
    ...matches.map((m) => ({ ref: m.source, score: 1, snippet: m.text, source: "notes" as const })),
    ...memories.map((m) => ({ ref: `memory:${m.key}`, score: 1, snippet: renderMemoryFact(m), source: "memory" as const }))
  ]);
}

export function formatSourceConflictWarning(hits: readonly RecallHit[]): string | undefined {
  const conflicts = detectSourceConflict(hits);
  if (conflicts.length === 0) return undefined;
  const lines = conflicts.map(
    (c) => `  • ${c.field}: "${c.valueA}" (${c.a.ref}) vs "${c.valueB}" (${c.b.ref})`
  );
  return `⚠️ Your sources disagree — verify before trusting:\n${lines.join("\n")}`;
}

/**
 * Detect pairs of hits that give DIFFERENT values for the SAME labelled field.
 * Only cross-hit disagreements count (two values in one snippet are not a
 * conflict). For each conflicting field the FIRST differing pair (in input order)
 * is returned. Pure and deterministic.
 */
export function detectSourceConflict(hits: readonly RecallHit[]): readonly SourceConflict[] {
  if (hits.length < 2) return [];
  const parsed = hits.map((hit) => ({ hit, fields: fieldsOf(hit.snippet) }));
  const conflicts: SourceConflict[] = [];
  const seenFields = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    for (const [field, valueA] of parsed[i]!.fields) {
      if (seenFields.has(field)) continue;
      for (let j = i + 1; j < parsed.length; j++) {
        const valueB = parsed[j]!.fields.get(field);
        if (valueB !== undefined && valueKey(valueA) !== valueKey(valueB)) {
          conflicts.push({ a: parsed[i]!.hit, b: parsed[j]!.hit, field, valueA, valueB });
          seenFields.add(field); // one conflict report per field
          break;
        }
      }
    }
  }
  return conflicts;
}
