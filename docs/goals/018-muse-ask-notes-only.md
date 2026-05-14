# 018 — `muse ask --notes-only`

## Why

`muse ask` defaults to web-search-enabled when `--with-tools` is
set. For a privacy / local-only run, the user wants RAG-grounded
answers from notes alone, no web. Add a flag that disables
muse.search + any other live network tools but keeps the agent
runtime + notes-RAG embedding path.

## Scope

- New `--notes-only` flag in `commands-ask.ts`.
- When set, mutate the metadata to disable web_search + filter
  the tool registry to notes + memory tools only.
- Mutually exclusive with `--with-tools` (or implies it).

## Verify

- pnpm check / lint / smoke broad.
- smoke:live: with --notes-only, the model never calls muse.search.
- cli +1 test.

## Status

open
