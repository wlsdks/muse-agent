# 076 — muse trace tail — live-tail recent traces

## Why

In-memory tracing pipeline has a  reader. Add a CLI subcommand
to print recent spans as they're recorded.

## Scope

- New commands-trace.ts with tail subcommand.
- SSE-style from /api/admin/traces?follow=1 OR local store read.

## Verify

- cli + api tests.

## Status

done — `muse traces tail [--interval N] [--limit N]` polls
`/api/admin/traces` (default 2s, clamped to [1, 60]) and
prints each newly-observed event as JSON-per-line. Per-tick
fetch limit defaults to 20, clamped to [1, 200].

In-process dedupe via `Set<traceEventKey>` keyed on
`(id || spanId || traceId) + (ts || timestamp)`, falling back
to the full JSON when no identifying fields exist — re-prints
don't happen on overlapping windows.

SIGINT exits cleanly via the goal 072 `wireReplGracefulExit`
helper so a Ctrl-C doesn't strand the polling timer.

Scope deviation: SSE follow is deferred — the in-memory trace
sink has no follow endpoint today, so polling is the right
interim shape. When SSE lands, swap the loop body; the pure
helpers (`resolveTraceTailIntervalMs`, `resolveTraceTailLimit`,
`extractTraceTailEvents`) stay as the contract.

cli +1 test exercises the three pure helpers across the
boundary matrix.
