/**
 * Robustly locate JSON arrays embedded in untrusted LLM text. The local
 * planner/detector models wrap their JSON in prose, and that prose collides
 * with the `[` delimiter (markdown `- [x]`, ranges `[1-3]`, citations `[2]`).
 * Anchoring on the literal first `[` — or, worse, scanning brackets without
 * tracking JSON strings so a `]` inside a value closes the span early —
 * silently drops a valid array. This scanner walks EVERY top-level balanced
 * span that parses as a JSON array and lets the caller's validity test pick.
 */

export interface JsonArrayCandidate {
  readonly text: string;
  readonly value: readonly unknown[];
}

/**
 * Index of the `]` that balances the `[` at `start`, or `-1` if it never
 * closes. Brackets inside JSON strings (and their escapes) are ignored so a
 * `]` in a string value can't close the array early.
 */
function balancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (character === "\\" && inString) {
      escape = true;
      continue;
    }
    if (character === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Yields each top-level balanced `[ … ]` span, in order, that parses as a
 * JSON array. Bracket spans that aren't valid JSON are skipped; the scan
 * resumes PAST each balanced span so a span's interior (e.g. a nested
 * `args:[]`) is never mistaken for a separate top-level array.
 */
export function* iterateJsonArrayCandidates(text: string): Generator<JsonArrayCandidate> {
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf("[", searchFrom);
    if (start < 0) {
      return;
    }
    const end = balancedArrayEnd(text, start);
    if (end < 0) {
      searchFrom = start + 1;
      continue;
    }
    const candidate = text.slice(start, end + 1);
    try {
      const value: unknown = JSON.parse(candidate);
      if (Array.isArray(value)) {
        yield { text: candidate, value };
      }
    } catch {
      // not valid JSON — fall through to the next top-level `[`
    }
    searchFrom = end + 1;
  }
}

/** The substring of the first balanced span that parses as a JSON array. */
export function extractFirstJsonArray(text: string): string | null {
  for (const candidate of iterateJsonArrayCandidates(text)) {
    return candidate.text;
  }
  return null;
}
