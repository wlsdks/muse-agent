# 753 — feat: weather actuator recovers from transient failures (P19 FLIP)

## Why

P19: a JARVIS you depend on survives real-world failure. The weather
provider (Open-Meteo, free, read-only world-sensing for `muse weather`
+ the proactive briefing) did a single `fetch` and threw on any
`!response.ok`. A transient 429 (rate-limit) or 5xx — common on a free
public API — crashed the lookup and silently dropped the briefing's
weather line, even though an immediate retry would have succeeded.

## Slice

`@muse/mcp` weather.ts:
- `isRetriableStatus(status)` — 429 + any 5xx are transient; every
  other status (incl. non-429 4xx) is permanent → fail fast.
- `fetchWithRetry(fetchImpl, url, options)` — retry-with-backoff
  (default 2 retries, 250 ms base, doubling) for transient statuses
  AND network rejects; permanent responses return immediately; the
  last attempt's response/error is handed back so the caller's own
  status handling still runs. `sleep` is injectable so tests don't
  wait on real timers; `retries`/`baseDelayMs` are finite-guarded.
- `OpenMeteoWeatherProvider` routes both the geocode and forecast
  fetches through it (new optional `RetryOptions` constructor arg).

## Verify

- `@muse/mcp` weather-retry.test.ts (new, 8) — contract-faithful fake
  `fetch` returning a real `Response` sequence, injected no-op sleep:
  - `isRetriableStatus`: 429/5xx transient; 2xx/3xx/4xx/600 permanent.
  - `fetchWithRetry`: recovers from 503,503→200 (3 calls); retries 429;
    fails fast on 404 (1 call, no retry); retries a network reject then
    rethrows after exhaustion (3 calls).
  - provider: `geocode` recovers from a transient 503 (2 calls); still
    throws a clear `geocoding failed (503)` once retries are exhausted
    (3 calls); `currentWeather` recovers from a transient 502.
- **Mutation-proven**: disabling 5xx/429 retry in `isRetriableStatus`
  fails 6 of the 8 tests; restore → 8/8.
- Full `pnpm check` EXIT 0 (mcp 682, every workspace green); `pnpm
  lint` 0/0. Weather is an HTTP actuator, not the model request/
  response path → no `smoke:live`; the fake fetch drives the real
  retry code path (not a stubbed provider).

## Decisions

- **Retry only transient classes (429 / 5xx / network reject).** A
  non-429 4xx is a permanent client error; retrying wastes the window
  and (for a rate-limit-adjacent 4xx) could worsen it. Fail fast.
- **Hand back the last response rather than throwing inside the
  helper** so each caller keeps its specific error message
  (`geocoding failed (N)` vs `forecast failed (N)`).
- **Read-only, idempotent — no approval gate.** `outbound-safety.md`
  governs actions toward a third party; a weather GET is neither, so
  retry is safe and needs no gate. (P19 actuators that MUTATE — email
  send, web action — would gate first, then retry only the confirmed
  send; those are separate slices.)
