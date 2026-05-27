## 839 — fix: a web-watch notice survives a transient delivery failure

## Why

P21 web-watch ("ping me when this page changes") had a reliability
defect in the runner: it advanced a watch's baseline BEFORE delivering
the notice, and the `sink.deliver` call was un-wrapped. So if delivery
failed on the edge tick (a messaging blip, `sendWithRetry` exhausted):
1. the baseline had already advanced → the edge was CONSUMED → the
   notice was lost FOREVER (next tick sees the new baseline, never
   re-fires), and
2. the throw propagated out of the per-watch loop → every LATER watch's
   check was skipped that tick.
A watch you set is a promise to ping you; silently dropping the ping on
a transient send failure breaks that promise.

## Slice

`@muse/mcp` web-watch.ts — `createWebWatchRunner.tick`:
- a non-triggered watch advances its baseline as before;
- a triggered watch delivers FIRST, and advances the baseline ONLY
  after a successful send — so a failed delivery leaves the old
  baseline and the edge RE-FIRES next tick instead of being lost;
- the `deliver` call is wrapped per-watch, so one watch's send failure
  no longer aborts the remaining watches this tick.

## Verify

`@muse/mcp` web-watch-runner.test.ts (+2, 4 total):
- a transient delivery failure (sink throws once) → the edge is NOT
  consumed: tick 1 delivers 0 (threw), tick 2 re-fires and succeeds
  (the notice is not lost);
- with two watches where the first's delivery throws, the second STILL
  delivers (loop not aborted) and only it is counted.
- The existing edge/steady + snapshot-failure-baseline tests stay
  green (no regression with a working sink).
- **Mutation-proven**: reverting to the original "advance baseline
  before deliver, unwrapped" order fails BOTH new tests while the
  steady-state tests still pass — the fix is exactly what closes the
  defect. `@muse/mcp` 901/901, `pnpm check` EXIT 0, `pnpm lint` 0/0.
  Runner internals, no LLM path / no model tool → no smoke:live.

## Decisions

- **Advance the baseline only after a successful send** — the baseline
  IS the "already-notified" memory; advancing it before the notice
  actually leaves is what made a transient failure permanent. Gating it
  on delivery success makes the edge durable across a messaging blip
  (re-fires until it gets through), the correct behaviour for a
  reliability-bearing watch.
- **Per-watch try/catch** so an unreachable destination for one watch
  can't blind the others. CAPABILITIES line under P19/P21 (web-watch
  daily-reliability hardening; no bullet flip).
