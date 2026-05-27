# 794 — fix: proactive notice sinks retry a transient messaging blip (P19 reach)

## Why

P19 reliability, the Reach axis. The situational briefing already
dispatches via `sendWithRetry`, but the web-watch / home-watch /
ambient tick sinks called `registry.send` SINGLE-SHOT — so a transient
messaging-provider 5xx silently DROPPED the proactive notice. A
daily-driver must not lose "your front door is unlocked" or "price
dropped under $40" because Telegram returned a one-off 503.

## Slice

- `@muse/mcp` — export the existing `sendWithRetry` (3 attempts,
  0/200/800ms backoff; short-circuits a permanent error via
  `MessagingProviderError.retryable`; returns after the first success
  so a delivered notice is never re-sent).
- `apps/api` web-watch-tick.ts + ambient-tick.ts — both sinks now
  dispatch through `sendWithRetry` instead of `registry.send`. (The
  home-watch daemon reuses `startWebWatchTick`, so it inherits the
  retry too.)

## Verify

- `apps/api` web-watch-tick-retry.test.ts (new, 1): a `flakyProvider`
  that throws a retryable `UPSTREAM_FAILED` (503) on its first send
  then succeeds — a fired web-watch notice (`processing → shipped`) is
  DELIVERED after the retry through a real `MessagingProviderRegistry`,
  not dropped.
- **Mutation-proven**: reverting the sink to single-shot
  `registry.send` → the transient-503 notice is dropped → the test
  fails; restore → 1/1. Full `pnpm check` EXIT 0, `pnpm lint` 0/0,
  `pnpm smoke:broad` 51/0. No LLM path → no `smoke:live`.

## Decisions

- **Retry is safe for notices** — `sendWithRetry` retries only when a
  send FAILED (returns after the first success), and these go to the
  USER's own channel (the low-risk path per outbound-safety), so there
  is no double-message-to-a-stranger risk; a permanent error
  (INVALID_DESTINATION / 401) short-circuits instead of burning the
  ladder.
- No bullet flip — P19 reliability hardening of the proactive-notice
  reach (web-watch / home-watch / ambient), matching the briefing's
  existing posture. CAPABILITIES line under P19.
