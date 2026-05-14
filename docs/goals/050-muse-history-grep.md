# 050 — muse history --grep <pattern>

## Why

Filter activity feed by substring/regex against the summary field.
Pairs with --kind / --since for narrower queries.

## Scope

- Add --grep flag.
- Apply after the existing merge + filter pipeline.
- Case-insensitive by default; --case-sensitive for strict.

## Verify

- cli +1 test.

## Status

done — `muse history --grep <pattern> [--case-sensitive]` filters
the unified activity feed by substring or regex against
`entry.summary`. Pattern compiled as a `RegExp` first; on
SyntaxError the value is escaped and re-compiled as a literal
substring, so naive user input never crashes the command.
Case-insensitive by default; `--case-sensitive` flips the flag.
To keep `--limit` honest under aggressive grepping, the fetch
limit gets a ×10 boost (bounded to 2000) before post-filtering.
Empty-result message is grep-aware. cli +1 unit test on
`compileHistoryGrep` covers substring / regex / case-sensitive /
fallback-on-invalid-regex.
