# 068 — muse doctor --watch (TUI)

## Why

Re-runs local doctor every N seconds, prints a refreshing dashboard.
Useful during a flaky environment chase.

## Scope

- --watch flag.
- 5s default interval.
- Clear screen + redraw.

## Verify

- cli +1 test.

## Status

done — `muse doctor --watch [--interval N]` reruns the health
check on a fixed cadence (default 5s, clamped to [1, 3600]) and
redraws via the same ANSI clear / cursor-home sequence
`muse status --watch` (goal 046) uses, so the two watch loops
feel identical.

`--json` short-circuits the loop and runs once — emitting JSON
on every tick is a stream-consumer's job, not doctor's.
SIGINT exits cleanly via the same `once → flag → break` pattern
the status-watch loop established.

The interval parser (`resolveDoctorWatchIntervalMs`) is exported
for direct boundary tests and mirrors `resolveStatusWatchIntervalMs`
so both commands share the same input contract.

cli +1 test asserts the interval parser boundaries (default /
invalid / sub-1s clamp / upper clamp).
