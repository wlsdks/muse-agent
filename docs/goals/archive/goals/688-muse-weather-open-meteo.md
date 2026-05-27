# 688 — P12 (first slice): `muse weather <location>` senses real-world weather via Open-Meteo (free, no API key) — a `WeatherProvider` abstraction + `OpenMeteoWeatherProvider` (geocode + current conditions) behind a direct user surface; read-only, so no outbound-safety gate

## Why

P10 (tiered orchestration) is complete; the human's P11–P16 actuator
breadth is the next priority. P12 (weather + location, read-only) is the
smallest first actuator: Open-Meteo is free, needs no API key, and is
pure world-sensing — `.claude/rules/outbound-safety.md` governs only
actions *toward a third party* ("Muse may read the world freely"), so
weather needs no approval gate.

This slice delivers the weather PROVIDER (behind a model-neutral
abstraction, the way calendar did) plus a direct `muse weather`
surface. It does not yet ground the agent's free-form answers or the
proactive briefing — that is the remaining work to flip P12.

## Slice

- `apps/cli/src/weather.ts` (new):
  - `WeatherProvider` interface (`geocode` + `currentWeather`),
    `GeocodedLocation` / `CurrentWeather` types.
  - `describeWeatherCode(code)` — WMO `weather_code` → text; an unknown
    code reports its number (no misleading "clear sky" default).
  - `formatWeather(location, current)` — human one-liner; optional
    fields (feels-like / humidity / wind) shown only when present.
  - `OpenMeteoWeatherProvider` — two read-only HTTP calls (geocoding
    API → lat/lon/timezone; forecast API → current conditions),
    injectable `fetchImpl`; non-finite numbers guarded to `undefined`.
  - `registerWeatherCommand` — `muse weather <location...>` with
    `--json`; unknown place / lookup failure ⇒ clear stderr + exit 1.
- `apps/cli/src/program.ts`: register the command (uses `io.fetch` when
  provided, else global `fetch`).
- `apps/cli/src/weather.test.ts` (new, 9 tests): `describeWeatherCode`
  (known + unknown), `formatWeather` (full + minimal), the provider's
  geocode / not-found / current-weather parsing over a faked fetch, and
  the command integration (seeded location → printed answer reflects
  the HTTP-faked forecast; unknown place → not-found, exit 1).

## Verify

- `pnpm --filter @muse/cli` weather.test.ts: 9 passed.
- **Clean-mutation-proven**: hard-coding the parsed temperature to `0`
  fails the command integration test (`overcast, 22°C` → `0°C`),
  proving the real forecast value flows through to the user-facing
  answer. Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- **Live schema validated**: `curl` against the real Open-Meteo
  geocoding + forecast APIs confirms the exact field names this code
  parses (`name`/`country`/`latitude`/`longitude`/`timezone`;
  `current.{temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,time}`).
- Byte-hygiene scan on the three touched files: clean.
- No LLM request/response path touched (the command does its own
  read-only HTTP to Open-Meteo, faked in tests) — `smoke:live` N/A.

## Status

P12 first slice delivered: weather provider + `muse weather` direct
surface. P12 stays `[ ]` pending the grounding step — a weather tool so
the AGENT grounds free-form answers ("do I need an umbrella?") and/or
the proactive briefing ("rain at 3pm — leave early").

## Decisions

- **Open-Meteo, no key, free** — satisfies the zero-cost / open-source
  constraint; no credential to store, no outbound-safety gate (read
  only).
- **Provider abstraction now, reuse later** — `WeatherProvider` is the
  seam the agent tool / briefing daemon will consume in the flip slice;
  kept in `apps/cli` for now (no premature package) since the only
  consumer today is the CLI command.
- **Unknown WMO code reports its number** — surfacing `weather code N`
  beats silently defaulting to "clear sky" and misinforming the user.
- **Direct command first, agent/briefing grounding next** — a usable
  surface ships now; wiring weather into the agent loop (a tool) and
  the briefing is a distinct, separately-verifiable slice.

## Remaining risks

- **Geocoding picks the top match** (`count=1`) — an ambiguous city
  name resolves to Open-Meteo's highest-ranked result; a future
  refinement could surface alternatives or accept lat/lon directly.
- **No caching / rate-limit handling** — each invocation makes two live
  calls; fine for an interactive command, but a briefing daemon that
  polls weather should add a short cache (future, with the grounding
  slice).
- **Not yet grounding agent answers / briefing** — the JARVIS payoff
  ("leave early, rain at 3") needs the tool/briefing wiring; this slice
  is the provider + direct surface only.
