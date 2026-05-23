# 813 — feat: weather tool defaults to the user's home location

## Why

807 gave the agent a `weather` tool but `location` was always required
— yet the most common daily-driver query is "what's the weather?",
meaning the USER's location. Requiring a location forced the model to
either know it or ask a clarifying question (an extra round — bad for
the small local model). Defaulting to the configured home location lets
"what's the weather?" be a single no-arg tool call.

## Slice

- `@muse/mcp` weather-tool.ts — `createWeatherTool({ defaultLocation? })`:
  when a default is set, `location` becomes OPTIONAL (dropped from
  `required`), its description says "omit for the user's home (<place>)",
  and a bare call falls back to the default. An explicit location still
  overrides. Without a default, `location` stays required (unchanged).
- `@muse/autoconfigure` index.ts — passes `MUSE_WEATHER_LOCATION` as
  the default (the same env the briefing already uses).

## Verify

- `@muse/mcp` weather-tool.test.ts (+3, 7 total, contract-faithful
  open-meteo fake): with `defaultLocation` a no-arg call uses the home
  location and `required` is absent; an explicit location overrides;
  without a default, `location` stays required and a no-arg call is
  `found:false`.
- **Mutation-proven**: neutralising the default fallback (always use
  the requested location) → the no-arg-uses-home test fails; restore →
  7/7. Full `pnpm check` EXIT 0, `pnpm lint` 0/0.
- Tool catalog rides the model request → live SELECTION wants
  `smoke:live`; Ollama down → deferred.

## Decisions

- **Optional only when a default exists** — the schema's `required` is
  conditional so a model without a configured home still gets the
  "you must give a location" contract, while a configured user gets the
  one-shot no-arg path. Reuses `MUSE_WEATHER_LOCATION` (no new config).
- No bullet flip — weather UX + one-shot-calling improvement.
  CAPABILITIES line under P20.
