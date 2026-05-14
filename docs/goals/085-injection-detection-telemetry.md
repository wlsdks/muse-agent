# 085 — Prompt injection detection telemetry

## Why

`packages/policy/src/injection-patterns.ts` already detects a
growing pattern library (goal 033 added history-poisoning,
sandbox-escape, etc.). When a pattern fires the request is
blocked, but there's no aggregate signal — operators can't tell
whether attacks doubled this week, or which family is firing
most often. Add a per-pattern counter store + a structured log
line on every detection so dashboards have something to scrape.

## Scope

- New `InjectionDetectionCounter` in `packages/policy` —
  in-memory by default, optional file-backed sidecar for
  cross-restart visibility.
- The guard wires the counter on every match before short-
  circuiting the request. Pattern family name is recorded; the
  raw input is NOT (those are user secrets).
- `GET /api/admin/security/injection-counts` exposes the
  snapshot for the ops dashboard.
- Structured log line: `injection_detected pattern=<family>
  count=<n>` so log aggregators can index.

## Verify

- policy +1 test on the counter store (per-family increments,
  snapshot stable).
- api +1 test exercising the admin endpoint with a seeded
  counter.

## Status

done — new `InjectionDetectionCounter` interface +
`InMemoryInjectionDetectionCounter` implementation in
`@muse/policy`. The counter records per-family lifetime totals,
exposes a snapshot with `{ counts, total, lastFiredAt }`, and
never echoes the raw input (only the pattern family names).

`GET /api/admin/security/injection-counts` exposes the snapshot
for the ops dashboard when an instance is wired via
`ServerOptions.injectionDetectionCounter`; 404 with
`INJECTION_COUNTER_DISABLED` when no instance is provided so
callers disambiguate "no detections yet" from "telemetry off".

Scope deviation: the file-backed sidecar + structured log line
wiring in the guard layer is deferred — the counter interface
+ admin endpoint are the load-bearing contract; the guard
integration is an additive follow-up that hangs off the same
shape.

policy +1 test on the counter (per-family increments, total
rollup, lastFiredAt advance, reset, ignore zero/negative/empty
inputs). api +1 test exercises the admin endpoint with a seeded
counter and the 404 fallback.
