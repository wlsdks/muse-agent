# 148 — `sendWithRetry` honours `MessagingProviderError.retryable`

## Why

The proactive-notice loop's `sendWithRetry` (goal 070) tried
every send three times with exponential backoff. Pre-iter it
treated every error the same: a permanent 401 (bad token), 404
(missing destination), or local `INVALID_DESTINATION` /
`INVALID_TEXT` validation failure burned the full 0 ms → 200 ms
→ 800 ms ladder before the loop gave up — adding ~1 s of latency
to every permanent failure AND obscuring the real error behind
two backoff cycles.

Goal 134 added `retryable: boolean` to `MessagingProviderError`
(429 + 5xx → true, everything else → false). This iteration
wires the loop to it: non-retryable errors break out of the
retry loop after the first attempt, retryable errors continue to
use the existing 3-attempt ladder.

## Scope

- `packages/mcp/src/proactive-notice-loop.ts`:
  - Import `MessagingProviderError` (was previously type-only).
  - After the catch, `if (cause instanceof MessagingProviderError
    && !cause.retryable) { break; }` — fall through to the
    `throw lastError` line.
  - Plain `Error` (no provider classification — e.g. transport
    glitch, JSON parse failure) keeps the existing retry-all
    behaviour, so the goal-070 "transient 5xx + plain Error
    network blip" path is unchanged.

## Verify

- Existing test (`gives up after 3 attempts and records failure
  in history (goal 070)`) throws a plain `Error` → still
  retries three times, still records the failure. Behaviour
  preserved.
- New test (`breaks out of the retry loop early on non-retryable
  messaging errors (goal 148)`) throws a `MessagingProviderError`
  with status 401 → exactly **1 attempt**, summary still records
  the failure.
- `pnpm --filter @muse/mcp test` — 322 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- No real-LLM path touched.

## Status

done — the proactive loop no longer wastes the backoff ladder
on permanent errors. The `retryable` contract added in goals 106
/ 134 / 135 / 136 is now consumed end-to-end in the messaging
dispatch path.
