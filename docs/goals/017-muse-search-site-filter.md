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

open
