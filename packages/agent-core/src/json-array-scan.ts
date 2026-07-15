/**
 * Robustly locate JSON arrays embedded in untrusted LLM text. The local
 * planner/detector models wrap their JSON in prose, and that prose collides
 * with the `[` delimiter (markdown `- [x]`, ranges `[1-3]`, citations `[2]`).
 * Anchoring on the literal first `[` — or, worse, scanning brackets without
 * tracking JSON strings so a `]` inside a value closes the span early —
 * silently drops a valid array. This scanner walks EVERY top-level balanced
 * span that parses as a JSON array and lets the caller's validity test pick.
 */

import { isRecord } from "@muse/shared";

export interface JsonArrayCandidate {
  readonly text: string;
  readonly value: readonly unknown[];
}

/**
 * Index of the `close` delimiter that balances the `open` at `start`, or `-1` if
 * it never closes. Delimiters inside JSON strings (and their escapes) are ignored
 * so a `]`/`}` in a string value can't close the span early.
 */
function balancedSpanEnd(text: string, start: number, open: string, close: string): number {
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
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function balancedArrayEnd(text: string, start: number): number {
  return balancedSpanEnd(text, start, "[", "]");
}

/**
 * Yields each top-level balanced `[ … ]` span, in order, that parses as a
 * JSON array. Bracket spans that aren't valid JSON are skipped; the scan
 * resumes PAST each balanced span so a span's interior (e.g. a nested
 * `args:[]`) is never mistaken for a separate top-level array.
 */
// Each unbalanced `[` makes balancedArrayEnd scan to end-of-string, and the
// next `[` re-scans — O(n²) on repetition-degenerate model output (e.g. a
// local model emitting thousands of `[`). Bound the total characters the
// balance scan may visit; realistic plan/detector output (a few KB, a
// handful of stray brackets) stays far under this, while a pathological
// blob stops scanning instead of blocking the event loop.
const MAX_SCAN_CHARS = 1_000_000;

export function* iterateJsonArrayCandidates(text: string): Generator<JsonArrayCandidate> {
  let searchFrom = 0;
  let scanned = 0;
  for (;;) {
    const start = text.indexOf("[", searchFrom);
    if (start < 0) {
      return;
    }
    const end = balancedArrayEnd(text, start);
    scanned += (end < 0 ? text.length : end) - start;
    if (scanned > MAX_SCAN_CHARS) {
      return;
    }
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

export interface JsonObjectCandidate {
  readonly text: string;
  readonly value: Record<string, unknown>;
}

/**
 * Object twin of `iterateJsonArrayCandidates`: yields each top-level balanced
 * `{ … }` span, in order, that parses as a JSON OBJECT (not an array). The local
 * synthesiser/judge models wrap their JSON in prose, and that prose collides with
 * the `}` delimiter — anchoring first-`{`-to-last-`}` swallows any trailing
 * brace-bearing prose and fails the parse. Same string/escape awareness and
 * total-scan bound as the array scanner.
 */
export function* iterateJsonObjectCandidates(text: string): Generator<JsonObjectCandidate> {
  let searchFrom = 0;
  let scanned = 0;
  for (;;) {
    const start = text.indexOf("{", searchFrom);
    if (start < 0) {
      return;
    }
    const end = balancedSpanEnd(text, start, "{", "}");
    scanned += (end < 0 ? text.length : end) - start;
    if (scanned > MAX_SCAN_CHARS) {
      return;
    }
    if (end < 0) {
      searchFrom = start + 1;
      continue;
    }
    const candidate = text.slice(start, end + 1);
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value)) {
        yield { text: candidate, value };
      }
    } catch {
      // not valid JSON — fall through to the next top-level `{`
    }
    searchFrom = end + 1;
  }
}

/** The substring of the first balanced span that parses as a JSON object. */
export function extractFirstJsonObject(text: string): string | null {
  for (const candidate of iterateJsonObjectCandidates(text)) {
    return candidate.text;
  }
  return null;
}
