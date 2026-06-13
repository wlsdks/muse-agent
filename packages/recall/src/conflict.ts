import type { RecallHit } from "./hit.js";

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
 * line/space boundary. Value runs to a clause end.
 */
const LABELLED_VALUE = /(?<![\w:])([A-Za-z][A-Za-z0-9 ]{1,40}?):[ \t]*([^\n.,;]+)/gu;

/**
 * Common PROSE prefixes that are not real attributes — two notes both opening
 * "Note: ..." / "TODO: ..." with different text are NOT a field disagreement.
 * Excluding them is what keeps the detector from over-firing on ordinary prose
 * (the dominant false-positive class).
 */
const PROSE_LABELS = new Set([
  "note", "notes", "todo", "fyi", "ps", "nb", "summary", "tip", "tips",
  "warning", "caution", "aside", "eg", "ie", "example", "context", "background"
]);

/** Normalize a field label for matching: lowercase, collapse whitespace, trim. */
function normalizeField(label: string): string {
  return label.toLowerCase().replace(/\s+/gu, " ").trim();
}

/** A label is a real attribute only if it's not a prose prefix and doesn't end in a digit (a stray time/number). */
function isAttributeLabel(field: string): boolean {
  return !PROSE_LABELS.has(field) && !/\d$/u.test(field);
}

/** Comparison key for a value: lowercase, collapse whitespace, strip wrapping quotes/trailing punctuation. */
function valueKey(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").replace(/^["'`]+|["'`]+$/gu, "").trim();
}

/** The first labelled value per field within one snippet (intra-hit duplicates ignored). */
function fieldsOf(snippet: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of snippet.matchAll(LABELLED_VALUE)) {
    const field = normalizeField(match[1] ?? "");
    const value = (match[2] ?? "").trim();
    if (field.length === 0 || value.length === 0 || !isAttributeLabel(field)) continue;
    if (!out.has(field)) out.set(field, value); // first wins — same-hit repeats aren't a cross-source conflict
  }
  return out;
}

/**
 * Detect pairs of hits that give DIFFERENT values for the SAME labelled field.
 * Only cross-hit disagreements count (two values in one snippet are not a
 * conflict). For each conflicting field the FIRST differing pair (in input order)
 * is returned. Pure and deterministic.
 */
/**
 * Compose the answer's grounding (ranked note chunks + past-session episodes)
 * into a source-conflict cue. The caller passes the SAME grounding that backed
 * the answer; a non-undefined return means two of those sources disagree on a
 * field and should be surfaced before the user trusts the answer. Pure.
 */
export function groundingConflictCue(
  notes: ReadonlyArray<{ readonly file: string; readonly text: string }>,
  episodes: ReadonlyArray<{ readonly id: string; readonly summary: string }>
): string | undefined {
  const hits: RecallHit[] = [
    ...notes.map((n) => ({ ref: n.file, score: 1, snippet: n.text, source: "notes" as const })),
    ...episodes.map((e) => ({ ref: e.id, score: 1, snippet: e.summary, source: "episodes" as const }))
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
  matches: ReadonlyArray<{ readonly source: string; readonly text: string }>
): string | undefined {
  return formatSourceConflictWarning(
    matches.map((m) => ({ ref: m.source, score: 1, snippet: m.text, source: "notes" as const }))
  );
}

export function formatSourceConflictWarning(hits: readonly RecallHit[]): string | undefined {
  const conflicts = detectSourceConflict(hits);
  if (conflicts.length === 0) return undefined;
  const lines = conflicts.map(
    (c) => `  • ${c.field}: "${c.valueA}" (${c.a.ref}) vs "${c.valueB}" (${c.b.ref})`
  );
  return `⚠️ Your sources disagree — verify before trusting:\n${lines.join("\n")}`;
}

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
