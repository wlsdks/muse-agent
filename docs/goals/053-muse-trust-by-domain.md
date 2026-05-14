# 053 — muse trust list --by-domain

## Why

Group trusted/blocked tools by their MCP server. Reveals 'I trust 3
tools from notion + 1 from gcal'.

## Scope

- Augment commands-trust.ts list with --by-domain flag.
- Parse tool names (prefix.action) → group.

## Verify

- cli +1 test.

## Status

done — `muse trust list --by-domain` groups entries by the
prefix before the first '.', so the user sees
"trusted (3 across 2 domains): [notion] 2, [gcal] 1" instead of
a flat alphabetised list. Tools without a dot land in an
`(unscoped)` bucket so they stay visible. The grouped shape is
also surfaced in the JSON output under `byDomain.trusted` /
`byDomain.blocked` so scripts can consume it. cli +1 unit test
on `groupToolsByDomain`.
