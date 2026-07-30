# @muse/resilience

Deterministic failure-handling primitives shared by every provider call: retry with backoff and
budget accounting, circuit breakers, timeouts, error classification, and model-fallback
strategy. No hidden retry magic — every policy here is an explicit, testable function.

## Public surface

- `.` (`src/index.ts`) — `retry`/`RetryOptions`/`RetryExhaustedError`, `computeRetryDelay` and
  `computeDecorrelatedRetryDelay`, `DefaultCircuitBreaker`/`CircuitBreakerRegistry`/
  `CircuitBreakerOpenError`, `withTimeout`/`TimeoutError`, `scaleRequestTimeout`,
  `classifyError`/`isCancellationLikeError` (error classification), `ModelFallbackStrategy`, the
  retry-budget primitives (`createRetryBudget`, `RetryBudgetExhaustedError`,
  `runWithRetryBudget`, `currentRetryBudget`), and `delay` (re-exported `sleep`).

## Depends on

- `@muse/model` — `ModelFallbackStrategy` types against the model provider contract.
- `@muse/shared` — `finiteOr`, `sleep`.

## Rules that bind this package

- Retry classification is `ModelProviderError.retryable`-driven: a 4xx (model-not-found, bad key)
  fails fast, 5xx/unknown MAY retry, per `../../.claude/rules/architecture.md`'s fallback rules —
  see the comment above the classifier call inside `retry()` before changing default behavior.
- Provider fallback goes through the explicit `FallbackStrategy` seam here, never an ad hoc
  retry loop inside an adapter, per `../../.claude/rules/architecture.md`.

## Tests

`pnpm --filter @muse/resilience test`
