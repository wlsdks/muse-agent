## 877 — fix: `muse feeds refresh` retries a transient 429/5xx (P19 hardening)

## Why

`loadFeedBody` (behind `muse feeds refresh` + the feed-watch perception
runner) was single-shot: a feed server's transient 429/5xx failed that
feed's refresh outright, while every sibling read actuator
(weather/calendar/email) already retries-with-backoff via
`fetchWithRetry`. Feed servers DO rate-limit and 5xx; a one-off blip
shouldn't drop a feed from the run. Exactly the P19 failure mode
(rate-limit / transient 5xx / retry-with-backoff) on an un-hardened
actuator.

## Slice

`apps/cli` commands-feeds.ts `loadFeedBody`: retry the fetch on a
retriable status (`isRetriableStatus` — 429/5xx, now exported from
`@muse/mcp`) with doubling backoff (default 2 retries / 250ms),
**bounded by the existing single wall-clock timeout** (the AbortController
caps total time). An abort (timeout) or network throw fails fast — no
retry; a 4xx or an exhausted 5xx still throws via the `!ok` check.
`retries` / `baseDelayMs` / `sleep` are injectable.

## Verify

`apps/cli` commands-feeds.test.ts (+2): a 503-then-200 fake fetch
returns the body after exactly 2 calls (self-heals); a persistent 503
throws "returned 503" after first+2 retries (3 calls); a 404 throws
immediately (1 call — 4xx is permanent, no retry). Existing
timeout/body-cap/ok tests stay green (abort fails fast, no extra
attempts).
- **Mutation-proven**: removing the retry (always break after attempt 0)
  fails both retry tests.
- `pnpm check` EXIT 0 (only the known voice flake; mcp 928 / autoconfigure
  262 / api 323 green), `pnpm lint` 0/0.

## Decisions

- **Retry on STATUS only, not thrown errors** — `fetchWithRetry` retries
  thrown errors too, which would retry an abort and blow the timeout
  (10ms timeout → 750ms of retry sleeps). An inline status-retry loop
  under the one AbortController keeps the timeout a hard total cap and
  still self-heals 429/5xx. Reuses `isRetriableStatus` for the shared
  classification.
- Exported `fetchWithRetry` / `isRetriableStatus` / `RetryOptions` from
  `@muse/mcp` (they existed in http-retry but weren't on the package's
  public surface).
- No new dependency.
