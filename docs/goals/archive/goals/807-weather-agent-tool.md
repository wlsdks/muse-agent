# 807 — feat: on-demand `weather` agent tool

## Why

Weather existed only as a proactive-briefing line (`resolveWeatherLine`)
— there was NO agent tool, so a `muse ask` conversation could not
answer "what's the weather in Seoul?" / "will it rain this
afternoon?". Weather is a core daily-driver perception and open-meteo
is keyless + zero-cost, so it should always be available on demand.

## Slice

- `@muse/mcp` weather-tool.ts — `createWeatherTool({ provider? })`
  exposes a `risk: "read"` tool `weather` (param `location`, described
  with an example) that calls `resolveWeatherLine` (which already folds
  in the goal-795 rain heads-up) and returns `{ found, location,
  weather }`, or `{ found: false }` for an empty / un-geocodable place
  (no guess). Defaults to `OpenMeteoWeatherProvider` (no API key).
- `@muse/autoconfigure` index.ts — registered unconditionally in the
  `DynamicToolRegistry` (keyless, so no opt-in gate); the relevance
  filter surfaces it only on weather-ish prompts.

## Verify

- `@muse/mcp` weather-tool.test.ts (new, 4, contract-faithful
  open-meteo fake): `risk:read` + returns a weather line for a found
  location (with the temperature); `found:false` for an empty location
  (no guess) and for an un-geocodable place; the `location` param
  carries an "e.g." example (one-shot bar).
- `@muse/autoconfigure` weather-tool-wiring.test.ts (new, 1): the REAL
  `createMuseRuntimeAssembly` exposes the `weather` tool (no creds
  needed).
- **Mutation-proven**: removing the empty-location guard → an empty
  location resolves a weather line → the no-guess test fails; restore
  → 4/4. Full `pnpm check` EXIT 0, `pnpm lint` 0/0.
- The exposed tool catalog rides the model request, so live SELECTION
  wants `smoke:live`; Ollama was down → deferred (the deterministic
  reachability + behavior are the verified claims).

## Decisions

- **Always available (keyless)** — unlike the credential-gated home
  tools, open-meteo needs no key and weather is a universal perception,
  so the tool is unconditionally registered; the relevance filter (not
  a config gate) controls when it's shown to the model.
- **Reuses `resolveWeatherLine`** — one weather-rendering path for both
  the brief and the tool, so the rain heads-up (795) comes for free.
- No bullet flip — perception EXPAND (weather on demand in
  conversation). CAPABILITIES line under P20.
