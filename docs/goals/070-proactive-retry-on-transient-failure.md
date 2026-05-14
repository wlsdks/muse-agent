# 070 — Proactive notice retry on transient messaging error

## Why

When the messaging provider returns 5xx, the proactive daemon should
retry with backoff instead of marking the notice as failed.

## Scope

- Read proactive-notice-loop.ts.
- Add 3-attempt retry with exponential backoff.
- Final failure still writes to history.

## Verify

- mcp +2 tests (3 transient 503 then success; 3 failures → final failure).

## Status

open
