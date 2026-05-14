# 052 — muse session lock --hours N

## Why

Pause proactive notices for N hours. Writes a marker file the proactive
daemon checks.

## Scope

- New commands-session.ts with lock / unlock / status subs.
- Proactive notice loop reads the marker; skip-and-log when active.

## Verify

- mcp + cli tests.

## Status

open
