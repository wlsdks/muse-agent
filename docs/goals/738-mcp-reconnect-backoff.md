# 738 — fix: MCP reconnect backoff actually grows + honors maxAttempts

## Why

`McpManager.reconnect()` reset health to a fresh `"unknown"` snapshot
(`reconnectAttempts = 0`) right before re-attempting `connect()`. So
when the reconnect failed again, `scheduleReconnect` read the just-reset
count (0) and set attempts back to **1 every cycle**. Two consequences,
both defeating the configured `reconnectPolicy`:

- **Exponential backoff never grew** — `nextReconnectAt` is
  `initialDelayMs * 2 ** (attempts - 1)`; with attempts pinned at 1 the
  delay stayed at `initialDelayMs` forever, hammering a down server at
  the fastest interval.
- **`maxAttempts` was never reached** — the terminal guard is
  `attempts > maxAttempts`; with attempts capped at 1 it never tripped,
  so a permanently-dead MCP server was retried indefinitely instead of
  going terminal.

The existing backoff test only covered a reconnect that SUCCEEDS on the
second try (attempts correctly reset to 0 on success), so the
repeated-failure path — where the bug lives — was uncovered.

## Slice

`reconnect()` now captures the prior `reconnectAttempts` before the
interim reset and threads it into the `"unknown"` snapshot, so a
subsequent failure's `scheduleReconnect` increments from the real count.
A successful connect still resets attempts to 0 (unchanged), so backoff
clears on recovery.

## Verify

- `@muse/mcp` mcp.test.ts — new case: a server whose every connect fails
  (listTools rejects) grows `reconnectAttempts` 1→2→3 with the delay
  doubling 100→200→400ms, then at attempt 4 > maxAttempts(3)
  `nextReconnectAt` becomes `undefined` (terminal) and `reconnectDue()`
  returns `[]`. **Mutation-proven** — restoring the attempts-0 reset
  fails it. The pre-existing successful-reconnect test still passes.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  reconnect-policy logic — no model path, no `smoke:live`.

## Decisions

- **Preserve attempts in the interim snapshot, don't move the reset** —
  the reset to `"unknown"` before connect is intentional (clears stale
  error/status while the attempt is in flight); only the attempts count
  must survive it. Success still resets to 0 via the healthy snapshot.
