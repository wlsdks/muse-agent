## 828 — feat: weather answers "will it rain Saturday?" — multi-day forecast

## Why

"Will it rain this weekend?" / "what's the weather Saturday?" is a daily
ask. The `weather` tool gave only the CURRENT weather + a 12-hour rain
heads-up — its own description even disclaimed "forecasts beyond today".
Open-Meteo already serves a free multi-day daily forecast (no key), so
this gap is pure capability we hadn't exposed.

## Slice — DEEPEN the existing tool, do not add one

To protect one-shot selection (tool-calling.md rule 5: one tool that
does the whole job; no new entry to confuse the local model), the
capability rides the EXISTING `weather` tool via a new optional `when`:

- `@muse/mcp` weather.ts — `OpenMeteoWeatherProvider.dailyForecast(location,
  {days})` (Open-Meteo `daily=weather_code,temperature_2m_max/min,
  precipitation_probability_max`, retry-hardened like the rest of the
  read path; malformed daily rows skipped). `DailyForecast` type +
  pure `formatDailyForecast` ("2026-05-25: slight rain, 14–21°C, rain
  70%") + `resolveForecastLine(provider, place, targetDateIso)`
  (fail-soft; undefined past the ~16-day horizon or when the provider
  can't forecast).
- `@muse/mcp` weather-tool.ts — optional `when` arg ("tomorrow",
  "Saturday", "2026-05-30", "내일"); resolved via the existing
  relative-time resolver to a local YYYY-MM-DD. With `when` → that
  day's forecast; without → current weather (unchanged). An
  unparseable / out-of-horizon day reports a clear `found:false`
  reason.

## Verify

`@muse/mcp` weather-daily-forecast.test.ts (12):
- `dailyForecast` requests the daily params + parses (drops a malformed
  row); recovers from a transient 503 (retry inherited).
- `formatDailyForecast` renders the temp range + rain chance.
- `resolveForecastLine` returns the matching day, undefined past the
  horizon, undefined for a provider with no `dailyForecast`.
- The tool: declares `when`; "tomorrow" → next day's forecast (fixed
  `now`); a past-horizon date → found:false with the date; an
  unparseable `when` → clear reason; WITHOUT `when` → current weather.
- **Mutation-proven**: the day-match `find(... === targetDateIso)` →
  `days[0]` breaks the horizon test; forcing the `when` branch off
  breaks the "tomorrow" test. Full `pnpm check` EXIT 0, `pnpm lint`
  0/0. The existing weather-tool.test.ts (5) still green (schema change
  is additive).
- The `weather` tool's NAME/keywords are unchanged, so its selection is
  unaffected; only argument-filling is new. The live smoke:live
  round-trip is `[UNVERIFIED-LIVE]` (Ollama down) but no NEW tool was
  added to the catalog.

## Decisions

- **One tool, optional `when`** over a separate `weather_forecast` tool
  — keeps the catalog flat (the human's #1 one-shot-selection priority)
  and matches tool-calling.md rule 5. Current-vs-forecast is one
  argument, not a tool-selection decision.
- **Local-date matching** (`YYYY-MM-DD` from the resolved phrase vs the
  forecast's local dates) — correct for the common same-timezone case;
  a cross-timezone target may differ by a day, an accepted edge.
  CAPABILITIES line under Perception (no bullet flip — deepens an
  existing capability).
