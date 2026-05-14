# 046 — muse status --watch (revive deferred 020)

## Why

Live-refresh muse status. Default 5s tick; --interval override; clean
Ctrl-C exit.

## Scope

- --watch flag + interval loop.
- Reuse collectStatus + formatted renderer.
- Clear screen between renders (ANSI clear).

## Verify

- cli +1 test (multi-render assertion).
- Manual dogfood verifies refresh.

## Status

done — `muse status --watch` redraws the dashboard on a fixed
cadence (default 5s, `--interval <seconds>` override clamped to
[1, 3600]) until SIGINT. The render path was extracted to a
shared `renderStatus(io, snap)` so the one-shot and watch loops
both consume `collectStatus` + the same formatted layout.
ANSI `\x1b[2J\x1b[H` clears + parks the cursor between ticks.
`--json` short-circuits watch (a watch loop emitting JSON every
tick is a stream consumer's job, not status's). cli +1 unit
test for the interval-parser boundaries.
