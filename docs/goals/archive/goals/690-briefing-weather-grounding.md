# 690 — P12 COMPLETE: the proactive situational briefing is grounded in real weather — a non-empty brief gains a current-conditions line for `MUSE_WEATHER_LOCATION` (the "rain — leave early" payoff); the `WeatherProvider` moves to @muse/mcp so the daemon can reuse it, weather is supplementary (never triggers a brief) and fail-soft

## Why

P12's first slice (goal 688) shipped the weather provider + a direct
`muse weather` command, but the bullet's headline — "grounds … the
proactive briefing ('rain at 3pm — leave early')" — was unmet because
the provider lived in `apps/cli` (the briefing daemon is in
`@muse/mcp`, which cannot import `apps/cli`). This iteration moves the
provider to `@muse/mcp` and wires it into the briefing, flipping P12.

## Slice

- **Move** the weather provider core (`WeatherProvider`,
  `OpenMeteoWeatherProvider`, `describeWeatherCode`, `formatWeather`,
  types) `apps/cli/src/weather.ts` → `packages/mcp/src/weather.ts`;
  add `resolveWeatherLine(provider, query)` (geocode → current → one
  line, fail-soft to `undefined`). Re-export from `@muse/mcp`.
  `apps/cli/src/weather.ts` now imports the provider from `@muse/mcp`
  and keeps only `registerWeatherCommand`. Provider/helper tests move
  to `@muse/mcp`; the CLI test keeps the command integration.
- `composeSituationalBriefing`: optional `weather?: string` → renders a
  `Weather: <line>` row. It rides an otherwise-non-empty briefing and
  is excluded from the empty-check, so weather NEVER triggers a brief
  on its own.
- `runDueSituationalBriefing`: optional `weatherProvider` +
  `weatherLocation`; when both are set AND the brief has content
  (imminent items or active/escalated objectives), it resolves the
  weather line (fail-soft) and passes it to the composer. An empty
  tick makes NO weather HTTP call.
- `apps/api` `startSituationalBriefingTick` + the
  `…DaemonIfConfigured` wiring: thread `weatherProvider`
  (`OpenMeteoWeatherProvider`) + `weatherLocation`
  (`MUSE_WEATHER_LOCATION`) through to the daemon.

## Verify

- `@muse/mcp`: weather.test.ts (helpers + provider + `resolveWeatherLine`
  fail-soft) + situational-briefing-loop.test.ts gains
  **"grounds the briefing with a seeded location's (HTTP-faked)
  forecast"** — a real `OpenMeteoWeatherProvider` (HTTP boundary faked)
  delivers a brief over the real `TelegramProvider` whose POSTed text
  contains `Weather: Seoul, South Korea: overcast, 22°C` alongside the
  imminent item — and "weather alone never triggers / no wasted fetch".
  All green.
- **Clean-mutation-proven**: removing the composer's `Weather:` render
  fails the briefing integration test (the seeded forecast no longer
  appears in the delivered message). Restored; green.
- `apps/cli` weather.test.ts (command) green after the provider move.
- `pnpm check`: EXIT=0 (cross-package: @muse/mcp + apps/api + apps/cli
  build + tests). `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- Byte-hygiene scan on all nine touched files: clean.
- No LLM request/response path touched — the briefing composer is pure;
  weather is a read-only HTTP fetch (faked in tests). `smoke:live` N/A.

## Status

**P12 FLIPPED.** Both named surfaces carry weather: the direct
`muse weather` answer (688) and the proactive briefing (690,
contract-faithful HTTP). A free-form agent-answer weather tool (so the
agent grounds "do I need an umbrella?" in chat) is a future additive
enhancement, not required by the bullet's check.

## Decisions

- **Provider home = @muse/mcp** — the briefing daemon lives there and
  `apps/api` + `apps/cli` both import `@muse/mcp`, so it is the
  reuse point without scaffolding a new package. (If weather grows
  more providers it can graduate to its own package, the way calendar
  has one.)
- **Weather is supplementary, never a trigger** — a JARVIS doesn't ping
  "it's sunny" with nothing else; the line only rides an
  already-worthwhile brief, and the daemon skips the HTTP call entirely
  on an empty tick.
- **`resolveWeatherLine` is fail-soft** — a geocode/forecast error
  returns `undefined` and the brief goes out without the line; weather
  must never break the briefing path.
- **Contract-faithful test** — the integration test uses the REAL
  `OpenMeteoWeatherProvider` with only `fetch` faked (proving the live
  geocode+forecast HTTP shape → briefing), over the REAL
  `TelegramProvider` send, never a fake registry.

## Remaining risks

- **No free-form agent weather tool yet** — the agent can't yet ground
  a chat answer ("umbrella?") in weather; that needs an IO tool
  (MCP-bridged, since `@muse/tools` is zero-IO). Additive, beyond the
  P12 check.
- **`MUSE_WEATHER_LOCATION` is a single static place** — a future
  refinement could derive location from the user profile / calendar
  event venue rather than one env value.
- **No forecast horizon in the briefing** — the line is *current*
  conditions; "rain at 3pm" precision needs the hourly forecast (a
  follow-up using open-meteo `hourly`).
