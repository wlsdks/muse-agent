# 034 — Audit long-running REPL session for memory growth

## Why

The chat-repl maintains in-memory history. Survey whether it has any
unbounded structures (per-message buffers, response cache without
eviction, accumulated SSE listeners) that grow without bound during a
multi-hour session.

## Scope

- Read chat-repl.ts + memory-related stores.
- Identify any growing-without-bound state.
- Add a small lock-in test (run 1000 turns, assert heap stays bounded)
  OR add eviction where missing.

## Verify

- If lock-in test added: cli or agent-core +1 test.
- Manual heap-usage observation.

## Status

open
