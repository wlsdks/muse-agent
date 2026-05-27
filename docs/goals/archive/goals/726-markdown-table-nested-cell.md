# 726 — fix: markdown_table renders a nested object/array cell as compact JSON, not `[object Object]`

## Why

`markdown_table` is an LLM-facing tool: the model calls it to render a
data array as a table it then shows the user. `formatMarkdownTableCell`
rendered every value via `String(value)`, so a cell holding a nested
object (`{lat: 1, lng: 2}`) became the useless string `[object Object]`,
and an array (`["a","b"]`) collapsed to a structure-losing comma join
(`a,b`). Tool results commonly carry nested objects (a geocode, a config
blob, a list of tags), so the user saw `[object Object]` in answers.

Rotated surface (PROCEDURE Step 8: recent iterations touched
messaging/channel, model, calendar, notes-rag, tools-time — this is the
text-formatting tool surface) after verifying PDF parsing, reindex
fail-soft, slugify, and the followup detector are all already robust.

## Slice

- `packages/tools/src/muse-tools-text.ts`: `formatMarkdownTableCell` now
  renders a `typeof === "object"` value (object or array) as
  `JSON.stringify(value)` (compact), keeping `String(value)` for
  primitives; pipe/newline escaping unchanged. Tool description updated
  to match. (null/undefined still render as an empty cell.)

## Verify

- `@muse/tools` tools.test.ts (147 tests): a row `{coords:{lat:1,lng:2},
  tags:["a","b"]}` renders `{"lat":1,"lng":2}` and `["a","b"]`, never
  `[object Object]`; the existing primitive / pipe+newline-escape /
  truncation / column-name cases are unchanged (no regression).
- **Mutation-proven**: reverting to `String(value)` fails the nested-cell
  test. Restored; green.
- `pnpm check`: EXIT=0 (no prompt/tool snapshot broke). `pnpm lint`: 0/0.
  `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — pure cell formatting.

## Decisions

- **Compact JSON, not pretty / not a recursive flatten** — a table cell
  is a single line; compact JSON keeps structure visible without
  newlines that would force `<br/>` soup, and is unambiguous (an array
  reads as `["a","b"]`, not `a,b`). `kv_summarize` already covers the
  deep-flatten use case.
- **`?? ""` guard on stringify** — `JSON.stringify` returns `undefined`
  for a value it can't serialise; fall back to an empty cell rather than
  the literal string "undefined".
