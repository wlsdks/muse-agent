# 105 — `muse setup local` pre-flight RAM check against the picked preset

## Why

`muse setup local` happily recommends `qwen3.6:27b` (17 GB on disk,
documented `minRamGb: 32`) even when run on an 8 GB MacBook Air.
The user pulls the model, hits 5-minute first-token latency or an
OOM kill mid-stream, and has no idea Muse already knew the
hardware was undersized.

JARVIS would refuse to launch the suit. Muse should at least say
"sir, this rig is undersized for that load-out."

## Scope

- New pure helper `checkPresetRam(machineRamGb, preset)` in
  `apps/cli/src/commands-setup-local.ts`:
  - Returns `undefined` when the rig clears the documented
    `preset.minRamGb` (or when the preset opts out via
    `minRamGb: 0`, the synthesised custom override case).
  - Returns `{ severity: "warn", message }` with a one-line fix —
    explicitly suggesting `muse setup local --model qwen3.5:2b-q4_K_M`
    as the low-tier fallback.
  - Skips on a non-finite / non-positive RAM reading so a unit-
    less environment can't manufacture a fake warning.
- The action prints the warning under the `tier:` / `note:` lines
  before the pull-or-write decision, so the user sees the gap
  *before* committing 17 GB of bandwidth.

## Verify

- New `apps/cli/src/commands-setup-local.test.ts` cases:
  - Clears the bar (≥ minRamGb) → no warning.
  - Below the bar → warning carries the rig RAM + preset tag +
    required RAM + low-tier fallback command.
  - `minRamGb: 0` custom preset → skip.
  - NaN / 0 / negative RAM reading → skip.
- `pnpm --filter @muse/cli test` — 331 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — `muse setup local` on an undersized rig now prints a
warning naming the gap. The recommendation isn't refused (the
user may still want to try); they just see the cost up front.
