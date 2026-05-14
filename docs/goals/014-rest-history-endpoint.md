# 014 — `GET /api/history` REST endpoint

## Why

`muse history` (CLI) and `muse.history.recent` (MCP) both consume
`readActivityFeed` from `@muse/mcp`. The web UI and external
clients have no REST equivalent — they'd have to embed the helper
or call the MCP loopback. Add the third surface.

## Scope

- New `apps/api/src/history-routes.ts` registers
  `GET /api/history?kind=&since=&limit=`.
- Auth-gated via `requireAuthenticated` (same posture as
  `/api/today`).
- Server.ts passes the five history-store paths through (same as
  the loopback wiring).
- Test: write seeds across 5 stores, hit endpoint, assert merged
  result.

## Verify

- pnpm check / lint / smoke broad + live.
- api +1 test.

## Status

open
