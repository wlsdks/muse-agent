# 029 — User-memory diff broadcaster

## Why

If the user runs `muse remember "new fact"` mid-session, an
in-progress chat-REPL won't see the new fact until next turn's
persona-expansion re-reads the file. Worse: an external Claude-
Desktop session reading via `muse.status.snapshot` MCP doesn't
get notified at all. Add a broadcaster (in-process pub/sub +
optional SSE) for user-memory changes.

## Scope

- `InMemoryUserMemoryDiffBroker` in `@muse/memory`.
- Upsert hooks fire `publish({ userId, changedKeys })`.
- API server exposes `GET /api/user-memory-diffs/stream?userId=`
  SSE.
- CLI REPL subscribes and prints a tiny "(persona updated:
  +name)" line when changes land.

## Verify

- pnpm check / lint / smoke broad.
- memory + api +2 tests.

## Status

open
