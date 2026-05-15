# 156 — `runDueFollowups` reuses `sendWithRetry` (closes the trio)

## Why

Three messaging-dispatch loops live in `@muse/mcp`:

| Loop                          | Retry treatment (pre-156)             |
|-------------------------------|----------------------------------------|
| `runDueProactiveNotices`      | `sendWithRetry` (goal 070 + 148)       |
| `runDueReminders`             | `sendWithRetry` (goal 149)             |
| `runDueFollowups`             | **single attempt — no retry**          |

Goal 149 deliberately deferred followups, citing concern that
the per-followup synthesis cost made a retry-on-send expensive.
That reasoning was wrong: synthesis runs **before** the
`registry.send` call (line 95 of `followup-firing-loop.ts`)
and is not inside the retry loop's scope. Adding `sendWithRetry`
to the send call wraps only the send — synthesis happens
exactly once per followup regardless of how many send attempts
the retry ladder uses. No extra LLM budget consumed.

This iteration closes the trio.

## Scope

- `packages/mcp/src/followup-firing-loop.ts`:
  - Import the shared `sendWithRetry` helper (already exists from
    goal 149).
  - Wrap the per-followup `registry.send` with it.
- `packages/mcp/test/mcp.test.ts`:
  - Existing test ("captures per-followup errors without aborting
    the loop") updated to use a non-retryable
    `MessagingProviderError(401)` so the retry path doesn't mask
    the expected failure — test intent ("errors don't abort the
    loop") preserved.
  - Two new tests covering the same shape as goals 070, 148, 149:
    - *retries transient messaging failures with exponential
      backoff (goal 156)* — plain `Error` thrown twice, third
      succeeds; asserts `delivered === 1`, `attempts === 3`, and
      crucially `synthesizeCalls === 1` (synthesis NOT re-invoked
      across send retries).
    - *breaks out of the retry loop early on non-retryable
      messaging errors (goal 156)* — `MessagingProviderError(401)`,
      asserts `attempts === 1`.

## Verify

- `pnpm --filter @muse/mcp test` — 326 tests pass (2 new + 1
  retrofitted to use non-retryable error class).
- `pnpm check` exit 0.
- `pnpm lint` exit 0.
- No real-LLM path touched (`smoke:live` unchanged).

## Status

done — every messaging-dispatch loop in `@muse/mcp` shares the
same transient-resilience contract: 3 attempts, exponential
backoff, non-retryable short-circuit. The `retryable: boolean`
contract added in goals 106 / 134 / 135 / 136 is now consumed
in every messaging surface end-to-end.
