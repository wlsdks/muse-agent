# 263 — a non-finite timeout made `withTimeout` instant-fail everything

## Why

`withTimeout(operation, timeoutMs)` is the core resilience
primitive wrapping provider/model calls and other cancellable
operations. Its "no timeout" fast path guarded only `<= 0`:

```ts
if (timeoutMs <= 0) {
  return operation(abortControllerFactory().signal);
}
…
timeout = setTimeout(() => { controller.abort(); reject(new TimeoutError(timeoutMs)); }, timeoutMs);
```

`NaN <= 0` is `false` and `Infinity <= 0` is `false`, so a
non-finite `timeoutMs` slipped past the guard into
`setTimeout(fn, NaN | Infinity)`. Node clamps a non-finite /
out-of-range timer delay to **1 ms**, so the operation was
aborted almost immediately and every call rejected with
`TimeoutError` (message literally `Operation timed out after
NaNms`). A single mis-configured value — e.g. a timeout derived
from `Number(process.env.X)` that yields `NaN`, or `Infinity`
deliberately meaning "no/large timeout" — therefore made **every
wrapped call instantly fail**, which for the model path means the
whole agent is dead with a confusing error. Exactly the
non-finite footgun the codebase's NaN-guard discipline (clamp /
parseBounded / Date-guard goals) exists to prevent, at a
boundary primitive that had no such guard.

## Scope

`packages/resilience/src/index.ts` — `withTimeout`:

- `if (timeoutMs <= 0)` → `if (!Number.isFinite(timeoutMs) ||
  timeoutMs <= 0)`. NaN, Infinity, and `<= 0` now all take the
  "no timeout — run the operation directly" path, the safe,
  least-surprising default (a non-finite timeout cannot mean
  "fail in 1 ms"). Valid finite positive timeouts are
  byte-for-byte unchanged.

One condition widened; no other behaviour, signature, or the
timeout/race/clear-timer logic touched.

## Verify

- `pnpm --filter @muse/resilience test` — 16 pass (was 15; +1).
  New test runs `withTimeout` with `NaN` and `Infinity` against a
  15 ms operation and asserts it resolves to the operation's
  value (not an instant `TimeoutError`). The existing
  "aborts operations that exceed the timeout" test (finite
  `timeoutMs: 1`, 20 ms op → `TimeoutError`) stays green —
  valid-timeout behaviour is unchanged.
- `pnpm check` — every workspace green (resilience 16, apps/cli
  560, apps/api 155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure timeout-guard
  branch; deterministic unit test is the rigorous verification —
  a live round-trip would not naturally produce a non-finite
  timeout, which is exactly why the unit test injects it).

## Status

done — a non-finite `timeoutMs` (NaN from a bad config, or
Infinity intended as "no timeout") no longer slips past the guard
to make Node's clamped 1 ms timer instant-fail every wrapped
operation; it is treated as "no timeout" and the operation runs
normally.
