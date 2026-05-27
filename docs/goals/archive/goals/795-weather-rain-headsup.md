# 795 — feat: weather rain heads-up in the briefing ("rain likely ~15:00")

## Why

The brief's weather line was CURRENT-only ("18°C, clear") — but the
canonical morning-assistant touch is the FORECAST: "rain likely around
3pm — bring an umbrella". The `WeatherProvider` exposed only
`currentWeather`; this adds a forecast-backed rain outlook and folds it
into the existing brief weather line with no daemon change.

## Slice

`@muse/mcp` weather.ts:
- `WeatherProvider.rainOutlook?(location, { now?, withinHours=12,
  minProbabilityPct=50 })` (optional) + `OpenMeteoWeatherProvider`
  implementation: GET the open-meteo hourly forecast
  (`precipitation_probability,weather_code`), return the FIRST future
  hour within the horizon at/above the probability threshold
  (`{ atIso, condition, probabilityPct }`), or `undefined` if dry.
- `formatRainHeadsUp(outlook)` → "rain likely ~15:00 (moderate rain,
  70%)".
- `resolveWeatherLine` appends the heads-up when the provider supports
  `rainOutlook` and rain is forecast; fail-soft (a forecast error
  keeps the base current-weather line). The briefing daemon already
  uses `resolveWeatherLine`, so the brief gains this with no wiring
  change.

## Verify

- `@muse/mcp` weather-forecast.test.ts (new, 4, contract-faithful
  open-meteo fake): `rainOutlook` returns the first future hour above
  threshold / `undefined` when the next 12h are dry / ignores past +
  beyond-horizon hours; **end-to-end** — `resolveWeatherLine` appends
  "rain likely ~HH:00 (moderate rain)" when rain is forecast.
- **Mutation-proven**: dropping the `prob >= minProb` threshold → a dry
  forecast wrongly flags rain → 3/4 fail; restore → 4/4. Existing
  weather tests 17/17 (no regression — `rainOutlook` is optional, the
  current-only path unchanged). Full `pnpm check` EXIT 0, `pnpm lint`
  0/0. HTTP read (not an LLM request/response path) → no `smoke:live`.

## Decisions

- **Optional provider method + fold into the existing line** — keeps
  `resolveWeatherLine` backward-compatible (a provider without
  `rainOutlook`, or a dry forecast, yields the unchanged current line)
  and surfaces in the brief with zero daemon change.
- **Probability threshold + horizon** — 50% within 12h by default so
  the heads-up is actionable, not "1% chance somewhere today".
  `now`/`withinHours`/`minProbabilityPct` injectable for deterministic
  tests.
- No bullet flip — P19 weather-actuator EXPAND feeding the P20/P8
  proactive brief. CAPABILITIES line under P19.
