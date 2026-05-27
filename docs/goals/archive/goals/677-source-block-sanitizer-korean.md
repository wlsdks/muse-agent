# 677 — `sanitizeSourceBlocks` recognizes Korean source headings (`출처` / `참고` / `참고 자료` / `근거`) and Korean empty-source fallbacks (`없음`, `해당 없음`, `확인된 출처 없음`), so a Korean-first Qwen response's trailing "출처: 없음" block is stripped the same as the English "Sources: None"

## Why

`packages/policy/src/source-block-sanitizer.ts:sanitizeSourceBlocks`
runs on every model response via the verified-sources response
filter (`response-filters-verified-sources.ts`). It strips a
trailing `Sources:` / `References:` block when that block is
either empty-fallback ("None", "N/A") or an all-linked
citation list the model copied verbatim.

But every pattern was **English-only**:

```ts
const sourceHeadingPattern = /^\s{0,3}(?:sources?|references?)\s*:\s*…/iu;
const emptySourceFallbackPatterns = [/^none\.?$/iu, /^n\/a\.?$/iu, …];
```

Muse is Korean-first (its response filters, persona templates,
and the casual-lure / greeting strippers are all Korean-aware).
A Qwen response in Korean naturally emits:

```
답변입니다.

출처: 없음
```

— "Sources: None" in Korean. The English-only heading pattern
doesn't match `출처:` / `참고:`, and the English fallback
patterns don't match `없음`. So the empty-source block is
**left in the response**, cluttering the Korean output with a
dangling "출처: 없음" the English path would have removed.

The fix extends the heading pattern with Korean source-section
keywords and adds Korean empty-fallback patterns. The block
**classifier still gates removal** (a block is removed only if
it's empty-fallback OR all-linked-with-evidence), so a
legitimate Korean `참고:` prose note (e.g. "참고: 이 내용은
추정입니다") — which is neither — is never stripped.

### Defect class

**i18n parity — a Korean-first product whose text-processing
only handles English** (first hit for source-block
sanitization; the response-filters elsewhere ARE Korean-aware,
this module was the holdout). Fresh class and fresh area
(policy/source-block-sanitizer) distinct from the recent
multi-agent (676), cli-vision (675), api-routes (674),
calendar (670/673), and messaging (668/669/672) runs.

Recent 10-iter window:

- 676: supervisor worker tiebreaker
- 675: vision data-URL base64 validation
- 674: strict ?limit= parse (api history)
- 673: Math.min/max spread RangeError (calendar)
- 672: HTTP timeout (LINE)
- 671: asymmetric validation (web-search)
- 670: calendar local-timezone render
- 669/668: HTTP timeout (messaging)

## Slice

- `packages/policy/src/source-block-sanitizer.ts`:
  - `sourceHeadingPattern` extended to
    `(?:sources?|references?|출처|참고\s*자료|참고|근거)` and the
    colon class widened to `[:：]` (half- AND full-width — a
    Korean response may use the full-width `：`).
  - `emptySourceFallbackPatterns` gains the Korean fallbacks:
    `없음`, `해당 없음`, `출처 없음`, `확인된?\s*출처(?:가|는)?\s*
    없(?:음|습니다)` (covers "확인된 출처 없음" / "확인된 출처가
    없습니다"), `참고 자료 없음`.
- `packages/policy/test/source-block-sanitizer.test.ts`:
  - **Three new tests**:
    1. Korean empty-source blocks — `출처: 없음`, `출처:\n-
       확인된 출처 없음`, `참고 자료: 해당 없음` — all stripped
       with `empty_source_block`.
    2. Korean linked-source block — `출처:\n- https://ko.wikipedia.org/…`
       — stripped with `linked_source_block`.
    3. **No false-strip** — a legitimate `참고: 이 내용은
       추정이며 확정이 아닙니다.` prose note is preserved
       (`removed: false`), proving the classifier still gates
       removal.

## Verify

- `pnpm --filter @muse/policy test`: 73 passed (70 prior + 3
  new). Full `pnpm check`: every workspace green (incl. the
  repo byte-hygiene test, which flags zero-width/BOM chars,
  NOT Hangul); tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the heading pattern to
  English-only (`(?:sources?|references?)`) makes EXACTLY the
  Korean empty-source and Korean linked-source tests fail —
  the `출처:` heading isn't recognised, so the block is left
  in the response (`removed: false` / content still contains
  the block). The Korean-prose-preserve test passes either way
  (an unrecognised heading also means "not removed", which is
  what that test asserts). Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean (Hangul is
  allowed; only zero-width / BOM bytes are forbidden).
- No LLM request/response wire path touched — this is a pure
  string sanitizer over already-generated output. `smoke:live`
  doesn't apply, though a real Qwen round-trip is exactly where
  this fires (Korean responses with source blocks).

## Status

Done. Korean source blocks are now handled at parity with
English:

| Trailing block (Korean response)        | Pre-fix         | Post-fix                       |
| --------------------------------------- | --------------- | ------------------------------ |
| `Sources: None` (English)               | stripped        | stripped (unchanged)           |
| `출처: 없음`                            | **left in**     | **stripped** (empty_source)    |
| `출처:\n- 확인된 출처 없음`             | **left in**     | **stripped** (empty_source)    |
| `출처:\n- https://…` (linked)           | **left in**     | **stripped** (linked_source)   |
| `참고: 이 내용은 추정입니다` (prose)    | left in (correct) | left in (classifier gates)   |

## Decisions

- **Korean headings via alternation, not a separate pattern**
  — one regex keeps the heading-match logic single-sourced.
  Order in the alternation: `참고\s*자료` BEFORE `참고` so
  "참고 자료:" matches the more-specific form (though both
  capture the same `rest`, so it's cosmetic here).
- **`[:：]` colon class** — Korean text often uses the
  full-width colon `：` (U+FF1A). Accepting both means a
  `출처：없음` (full-width) is recognised too.
- **Classifier unchanged** — removal is still gated on
  empty-fallback OR all-linked-with-evidence. Adding Korean
  headings can't over-strip: a `참고:` prose note fails both
  classifier checks and is preserved (test 3 pins this).
- **Korean fallback patterns cover the common shapes** — bare
  `없음`, `해당 없음`, `출처 없음`, the verb forms `확인된 출처가
  없습니다` / `확인된 출처 없음`, and `참고 자료 없음`. Not
  exhaustive, but the high-frequency ones a reasoning=false
  Qwen emits.
- **Mutation choice** — reverted the heading alternation. The
  Korean empty + linked tests fail (heading unrecognised → not
  removed); the prose-preserve test passes. Surgical proof.

## Remaining risks

- **Other Korean empty-fallback phrasings** the model might
  emit (`출처가 제공되지 않았습니다`, `근거 없음`) aren't all
  covered — the patterns target the high-frequency forms. A
  miss leaves the block in (no harm beyond the cosmetic
  dangling block, same as the pre-fix English-miss behaviour).
  Sibling-extendable as new phrasings are observed.
- **Mixed-language blocks** (`Sources: 없음`) — the English
  heading + Korean fallback now both match, so this works.
- **The `참고` heading is also a common Korean word for
  "note/reference"** — but the classifier (no URL + not an
  empty-fallback → keep) prevents stripping a legitimate
  `참고:` annotation. Verified by the prose-preserve test.
- **`근거` (basis/grounds)** as a heading is included; if a
  model uses it for a prose "근거: ..." reasoning line, the
  classifier again gates removal — only empty/linked blocks go.
