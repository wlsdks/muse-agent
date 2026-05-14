# 023 — `muse search` 429 / rate-limit hint

## Why

When SearXNG returns 429 (or DuckDuckGo cooldown), the user sees a
generic "search failed" line. Add detection: if status is 429,
hint "rate-limited — back off for a minute, or self-host SearXNG
(see docs/setup-local-llm.md)".

## Scope

- Modify `loopback-search.ts`'s error path or the CLI-side display.
- Status 429 → structured `{ error: "rate-limited", hint: "..." }`.
- CLI renders the hint inline.

## Verify

- pnpm check / lint / smoke.
- mcp +1 test (synthetic 429 response).

## Status

open
