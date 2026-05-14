# 073 — User-memory auto-extract write throttle

## Why

createUserMemoryAutoExtractHook fires after every turn. A burst of
short turns could churn the user-memory.json file. Throttle writes to
1/min per user.

## Scope

- Add a small in-process throttle wrapper.
- Defer extraction when within cooldown.

## Verify

- memory +1 test.

## Status

done — `createUserMemoryAutoExtractHook` gains
`extractionCooldownMs` (default 60_000 = 1/min per user) +
`now` (injectable clock). An in-process per-user
`Map<userId, lastFiredAtMs>` skips extraction when the previous
run for the same user fired within the cooldown window. Fail-
open: skipped extraction doesn't block subsequent runs.

A burst of short turns from one user no longer churns
`user-memory.json` or the extraction LLM. Different users are
independent buckets (alice firing doesn't gate stark's
cooldown). Explicit 0 disables the throttle for tests / unusual
operator setups.

memory +1 test exercises the full matrix: turn 1 fires, turn 2
10s later throttled, alice independently fires, 60s later
stark un-throttles, and `extractionCooldownMs: 0` disables the
gate entirely.
