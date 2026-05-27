# 680 — the `text_stats` tool counts user-perceived characters (graphemes via the built-in `Intl.Segmenter`) instead of UTF-16 code units, so an emoji / regional-indicator flag / combining-or-jamo sequence counts as the one character a human sees rather than over-counting 2+ code units

## Why

`packages/tools/src/muse-tools-text.ts:createTextStatsTool` is the
`text_stats` ambient tool the agent calls to answer "how many
characters / words / lines is this". It reported
`characters: text.length`, where `String.prototype.length` is the
**UTF-16 code-unit count**, not the count of characters a user
perceives:

| input  | what the user sees | `text.length` (code units) |
| ------ | ------------------ | -------------------------- |
| `👍`   | 1 character        | 2 (surrogate pair)         |
| `🇰🇷`   | 1 character (flag) | 4 (two regional indicators)|
| `각` (decomposed jamo) | 1 character | 3 (ㄱ+ㅏ+ㄱ)            |

So `text_stats("a👍b🇰🇷c")` returned `characters: 9` for a string a
human reads as 5 characters. Muse is i18n / Korean-first; a wrong
character count on any string containing emoji, a flag, or a combining
sequence is a wrong answer to a direct user question.

The fix counts **grapheme clusters** (UAX#29) via `Intl.Segmenter`,
which is built into Node (≥16) — zero dependency, zero cost. ASCII /
BMP text (incl. precomposed Hangul) is unaffected: one code unit per
grapheme, so the existing 47-character ASCII assertion still holds.

### Defect class

**Unicode-correctness of a user-facing count** — distinct from the
recent 10-iter window (vendor-block fallback 679, value-range bounds
678/673/671, i18n source-block 677, sort tiebreaker 676, base64 675,
strict parse 674, HTTP timeout 672). Fresh package (`@muse/tools`,
untouched in the recent window) and a fresh class (grapheme
segmentation, not a numeric-finite guard).

## Slice

- `packages/tools/src/muse-tools-text.ts`:
  - New module-level `graphemeSegmenter = new Intl.Segmenter(undefined,
    { granularity: "grapheme" })` + a `countGraphemes(text)` helper
    that iterates its segments. One WHY comment names the code-unit
    over-count.
  - `createTextStatsTool` now returns `characters: countGraphemes(text)`.
  - The tool description clarifies "character (user-perceived /
    grapheme)".
- `packages/tools/test/tools.test.ts`:
  - **One new test**: `"a👍b🇰🇷c"` → `characters: 5` (grapheme), which
    is distinct from both 6 (code points) and 9 (code units), so it
    pins grapheme counting specifically — not merely "not code units".

## Verify

- `pnpm --filter @muse/tools test`: 80 passed / 1 skipped (1 new). The
  pre-existing 47-char ASCII assertion is unchanged (ASCII grapheme ==
  code unit).
- **Clean-mutation-proven, two ways**:
  - revert to `text.length` (code units) → new test fails with
    `characters: 9`.
  - revert to `[...text].length` (code points) → new test fails with
    `characters: 6`.
  Only `countGraphemes` yields 5, so the test pins grapheme
  segmentation, not just "anything but `.length`". Restored; all green.
- `pnpm check`: EXIT=0 — every workspace builds + tests green.
- `pnpm lint`: 0 errors / 0 warnings (the `_segment` loop binding is
  `_`-prefixed per the unused-vars rule).
- Byte-hygiene scan on both touched files: clean.
- No LLM request/response wire path touched — `text_stats.execute` is a
  pure synchronous string function. `smoke:live` does not apply.

## Status

Done.

| input        | pre-fix `characters` | post-fix |
| ------------ | -------------------- | -------- |
| ASCII (47)   | 47                   | 47       |
| `👍`         | 2                    | 1        |
| `🇰🇷`         | 4                    | 1        |
| `a👍b🇰🇷c`     | 9                    | 5        |

## Decisions

- **Graphemes, not code points** — code points (`[...text]`) fix the
  surrogate-pair over-count but still split a flag (2) or a ZWJ /
  combining sequence. Grapheme clusters match what a human counts, so
  `Intl.Segmenter` is the correct primitive for a "how many characters"
  answer. The test asserts 5 (not 6) precisely to lock this in.
- **`Intl.Segmenter`, no dependency** — built into the Node runtime
  via ICU; no new package, no cost. Aligns with the zero-cost / local
  constraint.
- **`words` / `lines` unchanged** — word splitting on `\s+` and line
  splitting on `\r?\n` are already correct for the per-word / per-line
  counts; only the character dimension was code-unit-naive.
- **Whitespace-only still returns 0 across the board** — the
  documented early-return is untouched.

## Remaining risks

- **ZWJ emoji sequences across ICU versions** — `Intl.Segmenter`
  grapheme clustering for newer ZWJ sequences (e.g. a 7-codepoint
  family) depends on the runtime's ICU version. The new test uses a
  surrogate-pair emoji and a regional-indicator flag, both stable
  across the Node versions the repo runs (20) and targets (24), so the
  test is not ICU-version-fragile.
- **`slugify` still reduces non-ASCII to `untitled`** — a separate,
  deliberate behavior (URL-safe ASCII slugs); a Korean-aware slug mode
  would be its own goal, not folded in here.
