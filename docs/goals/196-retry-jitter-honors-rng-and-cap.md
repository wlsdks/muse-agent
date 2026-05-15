# 196 — retry jitter honors the injectable RNG and the maxDelay cap

## Why

`computeRetryDelay` (the backoff core behind every `retry()`
call — model fallback, MCP reconnect, etc.) had two coupled
defects in its jitter branch:

1. **Dead `random` option.** `RetryOptions.random?: () =>
   number` is a declared, public injectable RNG — the obvious
   purpose is deterministic jitter in tests. But
   `computeRetryDelay` hard-coded `Math.random()` and never
   read `options.random`. The option did nothing; jitter was
   untestable.

2. **`maxDelayMs` was not a hard ceiling under jitter.** The
   cap is applied to `base`:
   `base = Math.min(maxDelay, initial * multiplier ** …)`.
   Jitter is then added *after*:
   `Math.max(0, base - jitter + random()*jitter*2)`, range
   `[base - jitter, base + jitter)`. With `jitterRatio: 1` and
   `base` at the cap, the returned delay reaches ≈`2 ×
   maxDelay`. A caller who sets `maxDelayMs: 5000` to bound
   worst-case backoff could actually sleep ~10s — the existing
   test only covered the no-jitter path (`jitterRatio` default
   0), so the overshoot was invisible.

## Scope

- `packages/resilience/src/index.ts`:
  - Move `random?: () => number` from `RetryOptions` to
    `RetryPolicy` (it belongs next to `jitterRatio` — both are
    jitter policy; `RetryOptions extends RetryPolicy` so no
    caller breaks) and use `options.random ?? Math.random` in
    `computeRetryDelay`.
  - Clamp the jittered result with `Math.min(maxDelay, …)` so
    `maxDelayMs` is a true ceiling. The `jitterRatio === 0`
    fast path and the `base` computation are unchanged, so the
    existing bounded-delay test (no jitter → exact cap) still
    passes — no behavior change for the no-jitter path.
- `packages/resilience/test/resilience.test.ts`: two new cases
  — injectable RNG produces deterministic jitter at the lower
  bound / midpoint / upper bound; and `maxDelayMs` stays a hard
  ceiling with `jitterRatio: 1, random: () => 1` (250, not the
  pre-fix 500).

## Verify

- `pnpm --filter @muse/resilience test` — 15 pass (2 new).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Pure deterministic math — no model path, no smoke:live
  needed.

## Status

done — jitter is now deterministically testable via the
documented `random` hook, and `maxDelayMs` is an enforced
ceiling instead of a soft target that jitter could double.
