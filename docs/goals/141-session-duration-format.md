# 141 — `muse session lock/status` renders durations as `Xh Ym`

## Why

`muse session lock --hours 2` printed `session locked … — ~120 min`
and `muse session status` printed `… — ~120 min remaining`.
Functional but unergonomic — a 2-hour DND read as "two-figure
minutes". JARVIS-class duration formatting reads as `2h`, not
`~120 min`, and `1h 30m` not `~90 min`. Same shape goal 123
applied to relative-time prompt rendering.

## Scope

- `apps/cli/src/commands-session.ts`:
  - New exported `formatRemainingDuration(rawMinutes)`:
    - `< 1` (incl. NaN / negative) → `"<1 min"` (near-expired
      locks don't read as "0 min").
    - `< 60` → `"X min"`.
    - Exact hours → `"Xh"`.
    - Mixed → `"Xh Ym"`.
    - Rounding to the nearest minute (59.6 → `"1h"`).
  - `lock` action passes the raw minute float and renders via
    the helper.
  - `status` action keeps emitting the integer `minutesRemaining`
    in the `--json` payload (downstream consumers unaffected)
    but renders the human-readable line through the helper.

## Verify

- New `apps/cli/test/program.test.ts` case pins every branch
  (sub-1 min clamp, plain minutes, whole hours, mixed, rounding).
- Existing session round-trip test uses `--json` so it's
  unaffected.
- `pnpm --filter @muse/cli test` — 358 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — `muse session lock --hours 2` now prints
`session locked until … — 2h`, and `muse session status` reads
the same way.
