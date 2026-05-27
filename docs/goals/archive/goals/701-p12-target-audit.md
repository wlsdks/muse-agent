# 701 — P12 target-completion audit (the P→P seam check)

## Why

P0–P11 are audited; P12 (weather + location, read-only) is the next
oldest completed target with no `P12 audit —` line. Per the
iteration-loop PROCEDURE Step 4, the sole mandate is to re-run every
P12 `CAPABILITIES.md` check TOGETHER AND exercise P12 as one
end-to-end user flow against the falsifiable test ("seeded location →
the briefing/answer reflects the forecast").

## Verify (all re-run green TOGETHER)

- `@muse/mcp` 15/15 — weather.test.ts (`describeWeatherCode` WMO map +
  unknown-code, `formatWeather`, `OpenMeteoWeatherProvider`
  geocode/currentWeather over a faked fetch, `resolveWeatherLine`
  fail-soft) + situational-briefing-loop.test.ts weather grounding.
- `@muse/cli` 2/2 — weather.test.ts (`muse weather` answer reflects the
  HTTP-faked forecast; unknown place → not-found exit 1).
- `pnpm lint` 0/0; `pnpm check:capabilities` ✓.

## Seams (both already compose)

- **WeatherProvider → `muse weather` answer** — cli weather.test.ts
  drives the real command; its printed answer reflects the (faked)
  forecast.
- **OpenMeteoWeatherProvider → proactive briefing weather line** —
  situational-briefing-loop.test.ts uses the REAL provider (HTTP
  boundary faked) → `resolveWeatherLine` → `composeSituationalBriefing`
  → a brief delivered over a real `TelegramProvider`.

## End-to-end (live, falsifiable test)

Re-ran `muse weather` against the REAL free Open-Meteo API (no key):
- `muse weather Seoul` → "clear sky, 27°C · feels 26°C · humidity 38%
  · wind 6 km/h";
- `muse weather "San Francisco" --json` → fog, 10°C.
The real geocode → forecast → format chain works end-to-end — the
answer surface reflects the live forecast.

## Status

**PASS.** P12's two surfaces (the direct `muse weather` answer and the
proactive-briefing weather line) are genuinely delivered and compose;
the answer chain works live against the real API. No drift; no bullet
reopened. A `P12 audit — … — PASS` line is appended to the
`docs/goals/README.md` Rejected ledger.

## Decisions

- **No new seam test** — both P12 surfaces already compose in existing
  tests (cli weather + briefing-loop weather grounding); the audit
  re-runs them together and adds a live end-to-end dog-food. Adding a
  redundant seam test would be inward churn.
- **Live check is free + local** — Open-Meteo needs no key and is the
  read-only sensing P12 is about, so the live end-to-end is run
  directly (unlike the OAuth-gated email surfaces).
- **Audit is steering upkeep** — `docs(loop)`, not a counted iteration;
  no source change.

## Remaining

- **P13–P16 audits pending** — one per iteration, oldest first (P13
  next). After all are audited, extend OUTWARD-TARGETS toward the
  north star.
