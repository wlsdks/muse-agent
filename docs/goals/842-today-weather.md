## 842 — feat: `muse today` shows the weather

## Why

`muse today` — the on-demand "what's my day" command — surfaced tasks,
events, notes, reminders, and followups but NOT the weather, the #1
thing a person checks each morning. The proactive brief already grounds
on weather (834/resolveWeatherLine); the terminal command should too.

## Slice — CLI-only, both modes (no server change)

`apps/cli` commands-today.ts:
- `resolveTodayWeatherLine(env, provider?)` — keyed on
  `MUSE_WEATHER_LOCATION` (the user's home, goal 813); fetches the
  current-weather line via Open-Meteo (no key) using the existing
  fail-soft `resolveWeatherLine`. No location / a lookup failure →
  undefined (no weather line).
- After the briefing is obtained (local OR remote), the CLI fetches the
  weather line itself and attaches it to the briefing — so it shows in
  BOTH modes and in `--json` without touching the `/api/today` server
  route.
- `formatWeatherLine(weather)` renders a `Weather:` line under the
  header; `TodayBriefing.weather?: string` carries it into `--json`.

## Verify

`apps/cli` commands-today.test.ts (+1 describe, 14 total):
- `formatWeatherLine` renders "\nWeather: …\n", and "" when absent /
  blank;
- `resolveTodayWeatherLine` fetches for the configured home location
  (fake provider → "Seoul … clear sky");
- returns undefined when no `MUSE_WEATHER_LOCATION` is set (no weather
  line).
- **Mutation-proven**: removing the no-location guard makes it fetch
  with no location and fails the no-location test; making
  `formatWeatherLine` never render fails the render test. `apps/cli`
  131/131, `pnpm check` EXIT 0, `pnpm lint` 0/0. CLI fetch+display, no
  LLM request/response path → no smoke:live.

## Decisions

- **CLI fetches weather itself** (not via the briefing payload) so both
  the local and remote `muse today` show it with zero server-route
  change — the weather is attached to the briefing object after
  retrieval, so the default formatted output AND `--json` both carry
  it.
- **`--brief` LLM narration** doesn't yet fold weather into its prose
  (the external message builder ignores the extra field) — a noted
  follow-on; the default `muse today` fully shows weather, so the
  capability is delivered, not half-built. CAPABILITIES line under the
  CLI daily-driver surface (no bullet flip).
