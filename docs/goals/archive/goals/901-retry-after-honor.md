# Goal 901 — `fetchWithRetry` honours the server's `Retry-After` on rate-limit

## Outward change

Every read-only actuator that goes through `fetchWithRetry` (weather
lookups, smart-home reads, web-watch, inbox reads) now **obeys a
server's `Retry-After` header** when it's rate-limited (429) or told
to back off (503), instead of blindly using its own 250ms→500ms
exponential backoff. A real API that answers `Retry-After: 30` was
previously hit again ~250ms later — re-rejected, the second retry
wasted, the read failing for the user. Now Muse waits the interval
the server actually asked for, so the retry lands when the window has
reopened and the lookup succeeds.

## Why this, now

A genuine P19 daily-hardening gap: rate-limit is the headline
failure mode the directive names, and the retry layer handled the
*status* (429 is retriable) but ignored the *timing contract* the
server sends with it. Honoring `Retry-After` is the difference
between a retry that works and three retries that all bounce. It
hardens four actuators at once (all `fetchWithRetry` callers) for the
cost of one shared change.

## How

- New pure `parseRetryAfterMs(header, nowMs)` — RFC 7231: delta-seconds
  (non-negative integer → ms) or HTTP-date (→ ms-until, past clamps to
  0). Decimal / negative / junk / empty / missing → `undefined`. The
  date branch only runs when the value carries a `:` clock component,
  so the famously lenient `Date.parse` can't coerce junk like `"3.5"`
  into a stray date.
- In the retry loop, on a retriable response that will be retried, the
  parsed `Retry-After` (when present) replaces the exponential backoff
  for that wait. Clamped to `maxRetryAfterMs` (new option, default
  30000) so an absurd `Retry-After: 3600` can't freeze the agent turn;
  `maxRetryAfterMs: 0` ignores the header entirely (pure backoff).
- Unparseable / absent header → unchanged exponential-backoff path.
  State-changing sends still must not use `fetchWithRetry` (a retried
  POST double-acts) — unchanged.

## Verification

`packages/mcp` `weather-retry.test.ts` (`pnpm --filter @muse/mcp test`,
936 passing). Drives the REAL `fetchWithRetry` against a
contract-faithful fake `fetch` returning a `429` with a real
`Retry-After` header, capturing the injected `sleep` argument:
- delta-seconds `"3"` → sleeps exactly `3000`ms (NOT the 250ms backoff)
- absurd `"3600"` → clamped to the `maxRetryAfterMs: 5000` cap
- junk `"soon-ish"` → falls back to the `250`ms backoff
Plus direct unit tests for `parseRetryAfterMs` (delta-seconds,
HTTP-date relative-to-now + past-clamp, junk/decimal/negative/empty/
null/undefined → undefined). Mutation-proven: dropping the
`Retry-After` read in the loop fails the delta-seconds + clamp tests;
restored green. `pnpm check` green (mcp 936, apps/cli 1566, apps/api
323); `pnpm lint` 0/0. Read-only fetch path, no LLM round-trip → no
smoke:live (Ollama down regardless).

## Decisions

- Clamp rather than ignore a too-large `Retry-After`: a host asking
  for an hour is real, but blocking the turn for an hour is not
  acceptable for an interactive assistant — wait the cap, make the
  final attempt, then surface the failure normally.
- Required a `:` before attempting `Date.parse` rather than a strict
  IMF-fixdate regex: covers both IMF-fixdate and ISO timestamps while
  cheaply rejecting bare-number-ish junk, without over-fitting to one
  date spelling.
