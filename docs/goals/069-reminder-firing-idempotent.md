# 069 — Reminder firing idempotency on restart

## Why

If the reminder-firing daemon crashes between marking a reminder as
fired and writing notification log, restart could re-fire. Audit +
add a per-reminder fired_at marker check before re-firing.

## Scope

- Read reminder-firing-loop.ts.
- Add idempotency check.

## Verify

- mcp +2 tests (kill-mid-fire + restart).

## Status

open
