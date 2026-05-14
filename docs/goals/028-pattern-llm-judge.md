# 028 — Pattern detector LLM-judge mode

## Why

Notes search and episode search both have an `llm-judge` mode
(model decides which entries are relevant to a query). Pattern
search is rule-based only. Mirror the pattern: a `muse pattern
search "morning"` could rank patterns by relevance via an LLM.

## Scope

- Add `searchPatterns({ query, mode: "substring" | "llm-judge" })`
  to the pattern store.
- Mirror notes-search's LLM-judge prompt shape (return list of
  matching ids by relevance).
- CLI flag `--mode llm-judge` on `muse pattern search`.

## Verify

- pnpm check / lint / smoke broad + live.
- mcp +2 tests.

## Status

deferred
 — mirrors notes/episodes pattern but pattern search is less
called than notes/episodes. Worth doing once patterns have
been observed long enough that substring search starts feeling
limiting.
