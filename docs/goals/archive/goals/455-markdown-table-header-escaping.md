# 455 — `markdown_table` escapes pipes/newlines in column NAMES, not just cells

## Why

`createMarkdownTableTool` (`@muse/tools` `muse-tools-text.ts`) is
an agent-facing tool: the LLM calls `markdown_table` to render
JSON rows as a GFM table, and its **own description promises**
"pipes and newlines in cells are escaped (`\|` and `<br/>`)".
Body cells go through `formatMarkdownTableCell` (the single
source of that escaping). The **header row** did not:

```ts
lines.push(`| ${columns.join(" | ")} |`);          // raw column names
```

Columns derive from object keys (`deriveMarkdownTableColumns`) or
user-supplied `columns`. A key/column containing `|` or a newline
— valid JSON keys, or an LLM-/data-generated `{"a|b": 1}` — was
emitted **raw** into the header, injecting a spurious `|` (and,
for a newline, a literal line break) so the header's
pipe-delimited field count no longer matched the separator/body.
The table renders mis-aligned / multi-line-broken, and the LLM
that called the tool then reads back a garbled table — degraded
output on the agent's own formatting path.

This is the 415 / 432 / 443 advertised-but-inconsistently-
enforced class: the escaping contract is applied to body cells
but not to the header (a cell-position that the docstring's
"cells" promise should cover). The existing `markdown_table`
test escaped cell *values* but never a column *name* with
`|`/newline — so the header gap was **genuinely uncovered**.
Fresh file (`muse-tools-text.ts` never examined; tools last
touched goal 439, ~17 iterations ago); a text-structure
consistency `fix:`.

## Slice

- `packages/tools/src/muse-tools-text.ts` — the header row now
  maps each column through `formatMarkdownTableCell` (the **same
  single-source escaper** the body already uses), so headers and
  cells escape identically. The separator row is count-based and
  unaffected; `deriveMarkdownTableColumns` dedups on the raw key
  (correct — escaping is a render concern) and is unchanged.
  One line; behaviour byte-identical for every column name
  without `|`/newline (the overwhelmingly common case).
- `packages/tools/test/tools.test.ts` — a new focused `it`: a row
  whose keys are `"a|b"` / `"c\nd"` renders the exact
  `| a\|b | c<br/>d |` header (structurally valid 3-line table);
  an explicit `columns: ["x|y"]` is escaped too; a clean column
  name is asserted byte-identical (no regression).

## Verify

- New `it` green; full `@muse/tools` suite 72 passed (+1; 1
  pre-existing skip); the existing `markdown_table` omnibus test
  still green (clean-column behaviour unchanged); tsc strict
  (tools) EXIT=0.
- **Mutation-proven teeth** (clean Edit-based mutation after a
  perl attempt mis-evaluated `${…}` — recorded transparently):
  reverting the header to `columns.join(" | ")` makes the new
  test fail with exactly
  `expected '| a|b | c\nd |\n| --- | --- |\n| 1 | …' to be
  '| a\|b | c<br/>d |\n…'` — the precise pre-fix breakage (extra
  `|` + injected literal newline in the header); fix then
  restored, suite back to 72 green.
- `pnpm check` EXIT=0, every workspace green (tools 72, cli 739,
  …) — no regression; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure deterministic text rendering — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. `markdown_table` now honours its documented escaping
contract for column names as well as cells: a column key with a
pipe or newline produces a structurally valid table the calling
LLM can read, instead of a mis-aligned / line-broken one. Every
ordinary column name renders exactly as before.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a consistency `fix:` to an existing
agent tool, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Reused `formatMarkdownTableCell` for the header rather than a
  separate header-escaper: header and cell escaping MUST be
  identical (same `\|` / `<br/>` contract); a second escaper is
  exactly the drift the 413/432 single-source fixes exist to
  prevent.
- Recorded the perl-mutation mis-fire and the clean Edit-based
  redo transparently (the first attempt errored on `${}` in the
  replacement and changed nothing — it proved nothing; only the
  clean mutation is the evidence).
