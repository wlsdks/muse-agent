# 504 — direct test coverage for `sendWithRetry` (zero-coverage helper on two firing loops)

## Why

`packages/mcp/src/messaging-retry.ts` is the 42-LOC retry helper
used by both `proactive-notice-loop` and `reminder-firing-loop` —
the two production paths Muse uses to push notifications to
Telegram / Slack / Discord / macOS-notify / Linux-libnotify / LINE.
Pre-iteration it had zero direct unit tests: its contract was only
implicitly covered through the firing loops, so a future drift in
the retry ladder (count, backoff sequence, classification of
retryable vs non-retryable, instanceof check on the catch branch)
would land green in CI as long as the loop integrations stayed
happy.

The helper encodes four invariants the firing loops depend on:

1. **At most 3 attempts** on a retryable error (backoffs
   `[0ms, 200ms, 800ms]`).
2. **Short-circuit on non-retryable** `MessagingProviderError` —
   no burn of the backoff ladder for permanent failures
   (`INVALID_DESTINATION`, `UNAUTHORIZED`, 4xx).
3. **Retry on generic `Error`** — transient network errors
   (`ECONNRESET`, `ETIMEDOUT`) are not `MessagingProviderError`
   and must not be classified as permanent.
4. **Rethrows the last error** when all attempts exhaust.

Same 458-class iteration as 458/460/462/477/479/480/485/487/491/
492/496/498 — direct coverage of a zero-coverage helper on a
live production wire path.

## Slice

- `packages/mcp/src/messaging-retry.test.ts` — new file, 5
  focused tests, one per invariant + the resolves-on-first
  baseline:
  - resolves on the first successful attempt — no backoff
  - retries through a transient `MessagingProviderError(503)` and
    resolves on attempt 2
  - attempts at most 3 times and rethrows the last retryable error
  - short-circuits on a non-retryable
    `MessagingProviderError("INVALID_DESTINATION", "bad chat")` —
    `toHaveBeenCalledTimes(1)`
  - retries a generic `Error("ECONNRESET")` (no `.retryable`
    property)

Source `packages/mcp/src/messaging-retry.ts` is byte-identical to
HEAD — test-only iteration.

## Verify

- New test 5/5 green; full `@muse/mcp` suite green
  (512 passed); tsc strict (mcp) EXIT=0.
- **Clean-mutation-proven** (Edit-based): dropping the
  `if (cause instanceof MessagingProviderError && !cause.retryable)
  { break; }` short-circuit makes the non-retryable test fail with
  the precise pre-mutation symptom (`expected 1 times, but got 3
  times` — the full backoff ladder burned on a permanent failure)
  while every other test stays green; fix restored, suite back to
  5 green.
- `pnpm check` EXIT=0; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the new test file.
- Pure unit coverage — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-loop
  Step 9).

## Status

Done. The four invariants of `sendWithRetry` are now directly
asserted; a future drift in the retry ladder, the instanceof
guard, or the retryable classification will fail this file
instead of silently breaking notification delivery on two
production loops.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458-class direct-coverage iteration
on a zero-coverage helper, recorded honestly with this backlog
row — not a false metric.

## Decisions

- `MessagingProviderError` constructor signature is
  `(providerId, code, message, status?)` — the `retryable` field
  is computed by `isRetryableMessagingStatus(status)` (status 429
  or 500–599). To get a retryable instance the test passes
  `status=503`; for non-retryable, no status (`retryable=false`).
  Mirrors how the actual provider adapters throw — no fake
  `retryable: true` hack.
- Fake `MessagingProviderRegistry` rather than instantiating the
  real one: the helper only calls `registry.send(providerId,
  message)`. Building the full registry would couple the test to
  provider plumbing that is not the contract being pinned.
- The `OutboundReceipt` shape is `{ providerId, destination,
  messageId, raw? }` (no `sentAtIso` — that's a different
  upstream field). Discovered via `tsc` during verification — a
  reminder that the test file lives in `@muse/mcp` but consumes
  the `@muse/messaging` types, so the type contract is enforced
  by the build pipeline, not by hand.
- Mutation chose to drop the short-circuit (rather than e.g.
  break the loop count) because it asserts both the instanceof
  guard AND the `!retryable` check fire together — the most
  load-bearing line of the helper.
