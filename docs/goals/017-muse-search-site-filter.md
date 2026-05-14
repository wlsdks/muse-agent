# 017 — `muse search --site <domain>`

## Why

Common search refinement — restrict to one site. SearXNG accepts
`site:` operator in the query; DuckDuckGo HTML scraping does too.
Make it a flag so the user doesn't have to remember the operator
syntax.

## Scope

- New `--site <domain>` flag.
- When set, prefix `site:<domain>` to the query before sending.
- Validate domain format (no shell metas).
- Direct test: SearXNG call body includes the site: prefix.

## Verify

- pnpm check / lint / smoke.
- cli +1 test.

## Status

done — `--site <domain>` (goal 017) prepends `site:` to the query with domain-format validation; `--to-notes <path>` (goal 016) writes a markdown note via LocalDirNotesProvider, with `--overwrite` guard. cli +2 tests covering both flags + the overwrite-required negative path.
