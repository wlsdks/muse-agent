/**
 * Pure text-editing engine for `file_edit` / `file_multi_edit` — exact
 * match, then a whitespace/punctuation-tolerant fuzzy fallback, applied
 * with no disk I/O so it's trivially unit-testable in isolation from the
 * tool/approval-gate plumbing in `fs-write-tools.ts`.
 */

export interface FsEditSpec {
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export type EditOutcome = { readonly ok: true; readonly content: string; readonly fuzzy?: boolean } | { readonly ok: false; readonly reason: string };

const UNICODE_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu, "-"],
  [/[\u2018\u2019\u201A\u201B]/gu, "'"],
  [/[\u201C\u201D\u201E\u201F]/gu, '"'],
  [/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/gu, " "]
]

function foldUnicode(line: string): string {
  let out = line.trim();
  for (const [pattern, replacement] of UNICODE_FOLDS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Progressive line-block relaxations, exact-first — the same ladder Codex's
 * `seek_sequence` uses so a recalled snippet still lands when it differs from
 * disk only by trailing whitespace, indentation, or typographic punctuation.
 * Level 0 (identity) is covered by the exact substring pass, so the fuzzy
 * fallback starts at trailing-whitespace.
 */
const LINE_RELAXATIONS: ReadonlyArray<(line: string) => string> = [
  (line) => line.replace(/\s+$/u, ""),
  (line) => line.trim(),
  foldUnicode
];

/**
 * When exact matching fails, find a UNIQUE contiguous block of file lines that
 * matches `oldString`'s lines under the most exact relaxation that yields any
 * match. Returns char offsets into `content`, or a reason. Uniqueness is
 * required at each level (we never guess a location), keeping Muse's
 * no-partial-side-effects posture stricter than Codex's first-match seek.
 */
function findFuzzyBlock(
  content: string,
  oldString: string
): { readonly ok: true; readonly start: number; readonly end: number } | { readonly ok: false; readonly reason: "none" | "ambiguous" } {
  const contentLines = content.split("\n");
  let pattern = oldString.split("\n");
  if (pattern.length > 1 && pattern[pattern.length - 1] === "") {
    pattern = pattern.slice(0, -1);
  }
  if (pattern.length === 0 || pattern.length > contentLines.length) {
    return { ok: false, reason: "none" };
  }
  for (const relax of LINE_RELAXATIONS) {
    const relaxedPattern = pattern.map((line) => relax(line));
    const hits: number[] = [];
    for (let i = 0; i + pattern.length <= contentLines.length; i += 1) {
      let matched = true;
      for (let j = 0; j < pattern.length; j += 1) {
        if (relax(contentLines[i + j]!) !== relaxedPattern[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        hits.push(i);
      }
    }
    if (hits.length === 1) {
      const startLine = hits[0]!;
      let start = 0;
      for (let k = 0; k < startLine; k += 1) {
        start += contentLines[k]!.length + 1;
      }
      const matchedText = contentLines.slice(startLine, startLine + pattern.length).join("\n");
      return { end: start + matchedText.length, ok: true, start };
    }
    if (hits.length > 1) {
      return { ok: false, reason: "ambiguous" };
    }
  }
  return { ok: false, reason: "none" };
}

/** Exact (then unique line-block) match of `oldString`; null when neither hits. */
function matchAndReplace(content: string, oldString: string, newString: string, replaceAll: boolean): EditOutcome | null {
  const matches = countOccurrences(content, oldString);
  if (matches > 1 && !replaceAll) {
    return { ok: false, reason: `old_string matches ${matches.toString()} places — pass replace_all or use a longer, unique old_string` };
  }
  if (matches >= 1) {
    const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    return { content: next, ok: true };
  }
  // Exact match failed — fall back to a whitespace/punctuation-tolerant
  // line-block match (replace_all has no meaning for a single unique block).
  const fuzzy = findFuzzyBlock(content, oldString);
  if (!fuzzy.ok) {
    return fuzzy.reason === "ambiguous"
      ? { ok: false, reason: `old_string fuzzily matches multiple places — use a longer, unique old_string` }
      : null;
  }
  return { content: content.slice(0, fuzzy.start) + newString + content.slice(fuzzy.end), fuzzy: true, ok: true };
}

/**
 * Un-escape the JSON whitespace escapes a small model commonly DOUBLE-escapes —
 * it emits the two characters `\` `n` in its tool-call JSON instead of a real
 * newline, so the parsed old_string carries a literal `\n` that matches nothing.
 */
function unescapeWhitespace(text: string): string {
  return text.replace(/\\r\\n|\\n|\\r|\\t/gu, (seq) => (seq === "\\t" ? "\t" : seq === "\\r" ? "\r" : "\n"));
}

/**
 * When an edit misses by genuine CONTENT (not whitespace — that's the fuzzy
 * pass), name the file's closest line so the model can copy it verbatim on its
 * next attempt instead of re-guessing. Deterministic: ranks lines by shared-word
 * overlap with old_string's first non-empty line and requires a real overlap
 * (≥ half the target words, ≥2) so an unrelated miss gets NO noisy hint.
 */
function nearestLineHint(content: string, oldString: string): string | undefined {
  const target = oldString.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!target) {
    return undefined;
  }
  const targetWords = new Set(target.split(/\s+/u).filter((word) => word.length > 0));
  if (targetWords.size === 0) {
    return undefined;
  }
  let best: { line: string; score: number } | undefined;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    let shared = 0;
    for (const word of line.split(/\s+/u)) {
      if (targetWords.has(word)) {
        shared += 1;
      }
    }
    if (shared > 0 && (!best || shared > best.score)) {
      best = { line, score: shared };
    }
  }
  if (best && best.score >= Math.max(2, Math.ceil(targetWords.size / 2))) {
    return best.line.slice(0, 120);
  }
  return undefined;
}

/** Apply ONE edit to `content`, validating uniqueness. Pure — never touches disk. */
export function applyEdit(content: string, spec: FsEditSpec): EditOutcome {
  if (spec.old_string.length === 0) {
    return { ok: false, reason: "old_string must not be empty" };
  }
  if (spec.old_string === spec.new_string) {
    return { ok: false, reason: "old_string and new_string are identical — nothing to change" };
  }
  const replaceAll = spec.replace_all === true;
  const direct = matchAndReplace(content, spec.old_string, spec.new_string, replaceAll);
  if (direct) {
    return direct;
  }
  // Exact + line-block both missed. If old_string carries literal `\n`/`\t`
  // escapes (a double-escaping local model), un-escape old AND new together and
  // retry once — only adopted when the repaired form actually matches, so a
  // verbatim backslash-n in source (which the exact pass already caught) is never
  // rewritten and we never guess a location.
  const repairedOld = unescapeWhitespace(spec.old_string);
  if (repairedOld !== spec.old_string) {
    const repaired = matchAndReplace(content, repairedOld, unescapeWhitespace(spec.new_string), replaceAll);
    if (repaired?.ok) {
      return { ...repaired, fuzzy: true };
    }
  }
  const hint = nearestLineHint(content, spec.old_string);
  return {
    ok: false,
    // A gross miss (no close line) is exactly when the model is MOST lost, so it
    // needs the recovery action too — not a bare "not found" it would only retry.
    reason: `old_string not found: ${JSON.stringify(spec.old_string.slice(0, 80))}${
      hint
        ? `. Closest line in the file is ${JSON.stringify(hint)} — read the file and copy the exact text`
        : " — re-read the file with file_read and copy the exact current text (old_string must match byte-for-byte, including whitespace)"
    }`
  };
}

/** Apply edits in order on the evolving content; the first failure aborts (atomic). */
export function applyEdits(content: string, edits: readonly FsEditSpec[]): EditOutcome {
  let current = content;
  for (let index = 0; index < edits.length; index += 1) {
    const outcome = applyEdit(current, edits[index]!);
    if (!outcome.ok) {
      return { ok: false, reason: `edit ${(index + 1).toString()}: ${outcome.reason}` };
    }
    current = outcome.content;
  }
  return { content: current, ok: true };
}
