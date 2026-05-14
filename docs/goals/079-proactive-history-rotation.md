# 079 — Proactive-history.json rotation on size

## Why

Rotates ~/.muse/proactive-history.json when it exceeds N entries
(default 1000). Keeps the file from growing without bound.

## Scope

- Read personal-proactive-history-store.ts.
- Add maxEntries with rotation to .1 / .2 / ...

## Verify

- mcp +2 tests.

## Status

open
