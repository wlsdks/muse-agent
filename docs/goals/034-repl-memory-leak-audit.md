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

done — survey identified the in-memory `history` array in
chat-repl.ts as the only unbounded structure (every user +
assistant turn pushed; no eviction). Added a soft cap (default
2000 entries / 1000 turns; override via
MUSE_REPL_MAX_HISTORY_ENTRIES). When the array exceeds the cap,
older entries are spliced — on-disk history via
`appendLastChatTurn` stays authoritative; trimming only affects
what's passed to the next model call, which the runtime's own
context-window trim handles anyway. Lifted the env-parse into
`resolveReplHistoryCap` for direct unit testing (cli +1 test).
