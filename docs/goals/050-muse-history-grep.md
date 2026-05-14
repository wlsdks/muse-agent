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

open
