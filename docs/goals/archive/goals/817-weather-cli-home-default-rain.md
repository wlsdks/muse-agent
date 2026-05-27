# 817 — feat: `muse weather` defaults to home + shows the rain heads-up

## Why

The `muse weather` CLI required a `<location>` and printed current
conditions only — inconsistent with the agent tool (813, defaults to
home) and the brief (795, rain heads-up). So a bare `muse weather`
errored even with a configured home, and the terminal output never
told you it'd rain.

## Slice

`apps/cli` weather.ts — `location` becomes optional (defaults to
`MUSE_WEATHER_LOCATION`); the usage error names the env. The text
output appends the rain heads-up (`formatRainHeadsUp` over the
provider's `rainOutlook`, fail-soft) so it matches the brief. The
`--json` path is unchanged (structured current + location).

## Verify

- `apps/cli` weather.test.ts (+3, 5 total, host-routed open-meteo
  fake): a bare `muse weather` uses `MUSE_WEATHER_LOCATION`; no location
  + no home → usage error (exit 1) naming the env; a forecast with an
  hourly threshold crossing appends "rain likely …". Existing
  seeded-location + unknown-place tests unchanged.
- **Mutation-proven**: dropping the `MUSE_WEATHER_LOCATION` fallback →
  the no-arg-uses-home test fails; restore → 5/5. Full `pnpm check`
  EXIT 0, `pnpm lint` 0/0. CLI command (no LLM path) → no `smoke:live`.

## Decisions

- **One weather behaviour everywhere** — the CLI now matches the agent
  tool (home default) and the brief (rain heads-up), reusing the same
  `rainOutlook` / `formatRainHeadsUp`. The precise geocode/forecast
  error messages are kept (the text path still geocodes first), so
  not-found stays distinguishable from a lookup failure.
- No bullet flip — CLI surface UX consistency. CAPABILITIES line under
  P20.
