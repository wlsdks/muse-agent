# 736 — test: first coverage for the text-formatting LLM tools (`muse-tools-text.ts`)

## Why

`packages/tools/src/muse-tools-text.ts` ships four LLM-facing tools —
`text_stats`, `slugify`, `kv_summarize`, `markdown_table` — and had
**zero** test references (confirmed: no `.test.ts` names any of the
four builders). These are agent-callable formatting tools with several
non-obvious documented contracts (grapheme counting, slug truncation
re-trim, kv depth/line caps, markdown nested-cell JSON + pipe/newline
escaping + row cap) that nothing pinned. Same rotation pattern as 713
(data tools) / 724 (time tools): lock the documented behavior of an
otherwise-uncovered helper before it can regress silently.

A bug hunt across these tools (and the gemini sanitizer, the cost
queries, the anthropic response parser) found the text tools correct,
so this iteration is the verified coverage rather than a fix.

## Slice

New `muse-tools-text.test.ts` asserting the documented contracts:

- **text_stats**: multi-line word/char/line counts; a grapheme
  (`👍`, regional-indicator flag `🇰🇷`) counts as ONE character (not its
  UTF-16 length); whitespace-only / empty / missing → all zeros.
- **slugify**: collapse + edge-strip; NFKD diacritic stripping
  (`Café Crème` → `cafe-creme`); empty/punctuation-only → `untitled`;
  `maxLength` truncation re-trims a dangling dash; non-positive
  `maxLength` ignored.
- **kv_summarize**: nested dot-keys + `.N` array indices; explicit
  `[]`/`{}`/`null` leaves; null/undefined data → empty; depth cap at
  `KV_SUMMARIZE_MAX_DEPTH` (`[deep]`, deep leaf unreached); 200-line
  cap + `…(N more)`.
- **markdown_table**: derived first-appearance columns; nested cell as
  compact JSON (not `[object Object]`); pipe → `\|` and newline →
  `<br/>` escaping; explicit columns reorder + dedupe + empty missing
  cells; no-column input → `""`; 200-row cap + omitted-count line.

## Verify

- `@muse/tools` muse-tools-text.test.ts — all green.
- `pnpm check`: EXIT=0 (a first attempt failed `tsc` because the test's
  `call` helper under-typed `MuseTool.execute`; fixed to type the tool
  as `MuseTool` + pass a context — vitest's esbuild skips type-check so
  only the standalone build caught it). `pnpm lint`: 0/0.
- No source change → no `smoke:live`, no CAPABILITIES line (test-only).

## Decisions

- **Coverage, not a forced fix** — the tools were correct under every
  documented contract probed, so manufacturing a "bug" would have been
  dishonest churn. First coverage of an uncovered LLM-facing module is
  the real, verifiable value here.
