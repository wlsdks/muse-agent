## 845 — feat: `muse weather --days N` shows the multi-day forecast

## Why

828 gave the AGENT a multi-day forecast (the `weather` tool's `when`
arg → `dailyForecast`), but the `muse weather` CLI showed only current
conditions + a rain heads-up — no way to ask "what's the week look
like?" from the terminal. Same parallel-surface gap `muse calendar
free` (833) closed for availability.

## Slice — CLI flag over the existing engine

`apps/cli` weather.ts:
- `muse weather [location] --days <n>` — when set (1-16), fetches the
  daily forecast via the existing `OpenMeteoWeatherProvider.dailyForecast`
  (Open-Meteo, no key) and prints one `formatDailyForecast` line per day
  ("2026-05-26: slight rain, 13–19°C, rain 80%"). Without `--days`, the
  prior current-weather + rain heads-up output is unchanged.
- Validates `--days` (positive number) before fetching; a provider with
  no `dailyForecast` reports a clear error; `--json` emits
  `{location, forecast}`.

## Verify

`apps/cli` weather.test.ts (+2, 7 total), the REAL
`OpenMeteoWeatherProvider` over a host-routed fake fetch:
- `--days 2` (forecast endpoint returns a `daily` block) prints
  "Seoul, South Korea — forecast:" + the two day lines (clear-sky and
  slight-rain) with temp ranges + rain %;
- a non-numeric `--days` → usage error, exit 1.
- The existing 5 current-weather tests stay green (the `--days` path is
  additive). **Mutation-proven**: forcing the `--days` branch off fails
  the forecast test; dropping the days validation fails the non-numeric
  test. `apps/cli` 131/131, `pnpm check` EXIT 0 (0 non-voice failures),
  `pnpm lint` 0/0. CLI fetch + display, no LLM path → no smoke:live.

## Decisions

- **Reuse `dailyForecast` + `formatDailyForecast`** (828) — the engine
  is already tested; the CLI slice is the flag + fetch + render, each
  covered here. Mirrors `muse calendar free` (833) bringing a tool
  capability to the terminal.
- **`--days` opt-in, current weather as default** — the bare `muse
  weather` stays a fast "what's it like now"; the forecast is an
  explicit ask. CAPABILITIES line under the CLI weather surface (no
  bullet flip).
