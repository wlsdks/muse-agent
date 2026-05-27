# 563 — `validateRetryConfig` rejects non-finite `maxRetryCount` (goal-562 deferred sibling)

## Why

Direct goal-562 follow-up. Goal 562 closed the
`validateExecutionTimeout` NaN-bypass and explicitly deferred
`validateRetryConfig` to a fresh iteration with the rationale
"one validate gate per commit, tight scope". This iteration is
that follow-up.

Pre-fix:

```ts
export function validateRetryConfig(retryOnFailure: boolean, maxRetryCount: number): void {
  if (retryOnFailure && maxRetryCount < 1) {
    throw new SchedulerValidationError("...");
  }
}
```

Same shape, same defect: `NaN < 1` returns false, so a
non-finite `maxRetryCount` with `retryOnFailure=true` silently
passes the validate gate. The runtime guard in
`normalizeScheduledJob` (line 158) uses `Number.isFinite` and
catches NaN downstream, but the validation contract every
`ScheduledJobValidator.validate` call hits should fail loudly.

Real-world trip-wire: a corrupt persisted job (hand-edited DB
row, migration leftover) with `max_retry_count = NaN` and
`retry_on_failure = true` re-validated on a normalize/load
path would silently pass the gate; the runtime guard would
recover with `defaultRetryCount`, but the validation contract
should reject the load loudly so the operator gets an
actionable error.

## Slice

- `packages/scheduler/src/scheduler-helpers.ts` —
  restructured `validateRetryConfig` to early-return on
  `retryOnFailure=false` (the field is unused on that
  branch) and added the `!Number.isFinite(maxRetryCount) ||`
  prefix to the bound check. Added a 4-line WHY comment
  explaining the NaN trip-wire (matches goal-562's comment
  shape).
- `packages/scheduler/src/scheduler-helpers.test.ts` — added
  one `it(...)` covering NaN / +Infinity / -Infinity
  rejection when `retryOnFailure=true`. Also pinned a
  sibling assertion that `retryOnFailure=false` accepts NaN
  (the field is unused — no need to validate it).

## Verify

- New `it(...)` green; full `@muse/scheduler` suite green
  (83 passed, +2 vs baseline 81, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `!Number.isFinite(maxRetryCount) ||` prefix makes the new
  test fail with the precise pre-fix symptom — `NaN < 1 is
  false, so without the finite guard the gate would
  silently accept a non-finite retry count`. Fix restored,
  suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1000 passed, packages/scheduler 83
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure validator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the
  `ScheduledJobValidator.validate` gate, not the model
  loop.

## Status

Done. Both scheduler validate-gate NaN-bypasses (562 +
this) are now closed. The validate-gate / runtime-guard
contract is fully consistent for both `executionTimeoutMs`
and `maxRetryCount`. A future grep for raw `< N` / `> N`
guards on scheduler numeric fields without a preceding
`Number.isFinite` check should return zero hits on those
two functions; the convention is the codebase standard for
this surface.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a direct
goal-562 sibling NaN-bypass hardening on the second of two
scheduler validate gates, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Restructured the guard with an early-return on
  `retryOnFailure=false` rather than adding the finite
  check inside the original single-line condition. Reason:
  the original `if (retryOnFailure && maxRetryCount < 1)`
  short-circuits — when `retryOnFailure=false`, the
  `maxRetryCount` is never evaluated. Adding the finite
  check inside the same `&&` chain (e.g. `if
  (retryOnFailure && (!Number.isFinite(maxRetryCount) ||
  maxRetryCount < 1))`) preserves the short-circuit but
  is harder to read. The early-return is structurally
  clearer; the negative assertion `validateRetryConfig
  (false, NaN)` MUST still pass, and the test pins that.
- Test covers both the new behaviour (NaN/Infinity reject
  when retryOnFailure=true) and the negative assertion
  (NaN accepted when retryOnFailure=false). The negative
  matters because it documents WHY the guard is gated on
  retryOnFailure: the field is unused when retries are
  disabled, so its value is irrelevant.
- Mutation reverts only the precise delta (the
  `!Number.isFinite(maxRetryCount) ||` prefix). The
  early-return refactor isn't mutated separately — it's
  a pure restructure with no behaviour change for finite
  inputs, covered by the EXISTING `retryOnFailure=false,
  maxRetryCount=0 → no throw` test.
- Did NOT touch `defaultRetryCount` (= 3). It's a finite
  positive integer constant; not at risk.
