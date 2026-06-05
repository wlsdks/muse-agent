/**
 * `muse notes conflicts` — surface places the user's OWN notes assert
 * contradictory facts (two different WiFi passwords, prices, dates, names) so
 * the corpus can be fixed BEFORE recall ever grounds an answer on the wrong
 * one. The honesty edge turned inward: deterministic candidate generation
 * (notes that share salient tokens, so they are plausibly about the same
 * thing) gates a bounded set of LOCAL-model polarity calls.
 */

import type { ModelMessage, ModelProvider } from "@muse/model";

export interface ConflictNote {
  readonly path: string;
  readonly body: string;
}

export interface CandidatePair {
  readonly a: ConflictNote;
  readonly b: ConflictNote;
  readonly shared: number;
}

const STOPWORDS = new Set([
  "this", "that", "with", "from", "your", "have", "will", "they", "them", "then",
  "than", "when", "what", "which", "were", "been", "into", "about", "also", "just",
  "like", "some", "only", "over", "more", "most", "such", "very", "much", "each",
  "other", "there", "here", "their", "would", "could", "should", "because", "note",
  "notes", "todo", "http", "https", "www", "com"
]);

const TOKEN = /[a-z0-9][a-z0-9'-]*/gu;

/** Salient lowercase tokens (length ≥ 4, not a stopword) — a note's topic fingerprint. */
export function salientTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN)) {
    const token = match[0];
    if (token.length >= 4 && !STOPWORDS.has(token)) out.add(token);
  }
  return out;
}

export interface CandidateOptions {
  readonly minShared?: number;
  readonly maxPairs?: number;
}

/**
 * Cross-note pairs sharing at least `minShared` salient tokens — i.e. plausibly
 * ABOUT the same thing, the prerequisite for a contradiction. Ranked by shared
 * count (most-overlapping first) and capped at `maxPairs` so the downstream
 * model calls stay bounded. Pure: no IO, no model. A note is never paired with
 * itself.
 */
export function selectConflictCandidatePairs(
  notes: readonly ConflictNote[],
  options: CandidateOptions = {}
): readonly CandidatePair[] {
  const minShared = Math.max(1, Math.trunc(options.minShared ?? 2));
  const maxPairs = Math.max(1, Math.trunc(options.maxPairs ?? 12));
  const fingerprints = notes.map((note) => salientTokens(note.body));
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const a = fingerprints[i]!;
      const b = fingerprints[j]!;
      const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
      let shared = 0;
      for (const token of smaller) if (larger.has(token)) shared += 1;
      if (shared >= minShared) pairs.push({ a: notes[i]!, b: notes[j]!, shared });
    }
  }
  pairs.sort((x, y) => y.shared - x.shared);
  return pairs.slice(0, maxPairs);
}

export interface SemanticNote {
  readonly path: string;
  readonly body: string;
  readonly centroid: readonly number[];
}

export interface SemanticCandidatePair {
  readonly a: SemanticNote;
  readonly b: SemanticNote;
  readonly cosine: number;
}

export interface SemanticCandidateOptions {
  readonly minCosine?: number;
  readonly maxPairs?: number;
}

/**
 * EMBEDDING-based candidate pairs — notes whose centroid cosine is at least
 * `minCosine` (i.e. about the same TOPIC even when they share little vocabulary,
 * which the lexical `selectConflictCandidatePairs` would miss: "rent is 2000/mo"
 * vs "monthly housing cost: 1800"). The cosine function is injected so this stays
 * a pure, dependency-free helper. Ranked by cosine descending, capped at
 * `maxPairs`. A note is never paired with itself.
 */
export function selectSemanticConflictCandidatePairs(
  notes: readonly SemanticNote[],
  cosineFn: (a: readonly number[], b: readonly number[]) => number,
  options: SemanticCandidateOptions = {}
): readonly SemanticCandidatePair[] {
  const minCosine = options.minCosine ?? 0.55;
  const maxPairs = Math.max(1, Math.trunc(options.maxPairs ?? 12));
  const pairs: SemanticCandidatePair[] = [];
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const score = cosineFn(notes[i]!.centroid, notes[j]!.centroid);
      if (score >= minCosine) pairs.push({ a: notes[i]!, b: notes[j]!, cosine: score });
    }
  }
  pairs.sort((x, y) => y.cosine - x.cosine);
  return pairs.slice(0, maxPairs);
}

export type NoteContradictionVerdict = "contradict" | "agree" | "unrelated" | "uncertain";

const NOTE_CONFLICT_SYSTEM_PROMPT =
  `You compare two notes from the SAME person's knowledge base and decide how their FACTS relate. Answer with EXACTLY one word:
- CONTRADICT — they assert facts that cannot both be true (the SAME thing has two DIFFERENT values: two different passwords, prices, dates, addresses, or names for one item).
- AGREE — they are consistent; one restates or supports the other.
- UNRELATED — they are about DIFFERENT things, so neither confirms nor conflicts.
Compare numbers, names, and negation carefully. Output ONLY the one word, nothing else.`;

/** Trim a note body for the prompt — the salient fact is usually near the top; keeps cost bounded. */
function clip(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Ask the LOCAL model whether two notes contradict, mirroring
 * `classifyCorrectionContradiction` (one word, temp 0). NOT secret-redacted on
 * purpose: the differing value is often the secret itself (a password), and the
 * data never leaves the box under local-only — redaction would mask the very
 * conflict being looked for. Any error / unparseable reply → "uncertain".
 */
export async function classifyNoteContradiction(
  a: string,
  b: string,
  options: { readonly modelProvider: Pick<ModelProvider, "generate">; readonly model: string }
): Promise<NoteContradictionVerdict> {
  const messages: readonly ModelMessage[] = [
    { content: NOTE_CONFLICT_SYSTEM_PROMPT, role: "system" },
    { content: `Note A: "${clip(a)}"\nNote B: "${clip(b)}"\nOne word:`, role: "user" }
  ];
  let output: string;
  try {
    const response = await options.modelProvider.generate({ maxOutputTokens: 12, messages, model: options.model, temperature: 0 });
    output = (response.output ?? "").toUpperCase();
  } catch {
    return "uncertain";
  }
  const match = output.match(/CONTRADICT|AGREE|UNRELATED/u);
  if (!match) return "uncertain";
  return match[0] === "CONTRADICT" ? "contradict" : match[0] === "AGREE" ? "agree" : "unrelated";
}

export interface NoteConflict {
  readonly a: string;
  readonly b: string;
}

/** Render the confirmed conflicts (pure). Empty → an explicit all-clear line. */
export function formatNoteConflicts(conflicts: readonly NoteConflict[]): string {
  if (conflicts.length === 0) {
    return "✓ No contradictions found among your notes.\n";
  }
  const lines = conflicts.map((conflict) => `  ⚠️ ${conflict.a} ↔ ${conflict.b}`);
  return `Found ${conflicts.length.toString()} place(s) your notes disagree:\n${lines.join("\n")}\nReview these — Muse may otherwise ground an answer on the wrong one.\n`;
}
