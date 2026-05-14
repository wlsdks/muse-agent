# 038 — Followup persistence durability — fsync + recovery

## Why

Followups are written by the capture hook on every assistant turn. A
crash between the upsert call and the disk fsync could lose recently
captured promises. Audit the write path for durability + add a recovery
mode that re-scans uncommitted entries on startup.

## Scope

- Read personal-followups-store.ts.
- Confirm writeFollowups uses atomic rename. If not, add it.
- Optional: write to a wal-like sidecar before swap.

## Verify

- mcp +1-2 tests (crash-simulation: kill mid-write, recover state).

## Status

open
