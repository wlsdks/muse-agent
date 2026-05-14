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

done — `writeFollowups` opens the tmp file via `fs.open` + calls
`handle.sync()` (fsync) before close, ensuring the payload lands
on disk before the atomic rename. Without this, a power loss
between writeFile and rename could commit the rename pointing at
zero-length data on filesystems that journal metadata + data
separately. Plus new `cleanupFollowupTempFiles(file)` to scrub
orphan `.tmp-*` siblings on demand. mcp +2 tests.
