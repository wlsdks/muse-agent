# 047 — muse ask --notes-only (revive deferred 018)

## Why

Disable web_search + filter tool registry to notes + memory tools
only, when --notes-only is set.

## Scope

- Flag handler in commands-ask.ts.
- Tool registry filter.
- smoke:live: model does NOT call muse.search when --notes-only is set.

## Verify

- cli +1 test + live verify.

## Status

open
