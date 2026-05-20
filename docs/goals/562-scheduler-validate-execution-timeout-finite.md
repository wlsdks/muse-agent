# 562 — `validateExecutionTimeout` rejects non-finite values (NaN / Infinity slip past raw `<`/`>` comparisons)

## Why

Step-8 redirect onto a fresh package — `packages/scheduler` —
with a different defect class from the recent polish sweep
(comparator-determinism, persona CLI, calendar validation,
trim-symmetry, integer-overflow). The defect is
**NaN-bypasses-range-check** on the scheduler validation gate.

Pre-fix:

```ts
export function validateExecutionTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs === undefined || timeoutMs === 0) {
    return;
  }
  if (timeoutMs < minExecutionTimeoutMs || timeoutMs > maxExecutionTimeoutMs) {
    throw new SchedulerValidationError(...);
  }
}
```

`NaN < N` and `NaN > N` both evaluate to `false` for any finite
`N`, so a non-finite `timeoutMs` (NaN, ±Infinity) silently
passes the range check. The `ScheduledJobValidator.validate`
gate (the contract callers rely on to reject bad input before
the job lands in the DB) lets the invalid value through.
Downstream `resolveJobTimeout` has a `Number.isFinite(value)
&& value > 0` runtime guard that catches the leak before it
hits `setTimeout`, but the validate gate is the contract —
"accept ⟺ validate" is the sibling-asymmetry shape from
goals 555/560.

Real-world trip-wire: a corrupt persisted job (hand-edited
DB row, a migration that left NaN in `execution_timeout_ms`)
re-validated on a normalize/load path would silently pass the
gate. The runtime guard would catch it, but the validation
contract should fail the load loudly so the operator gets
an actionable error.

Same defect class as goal 560 (calendar updateEvent
validation parity with createEvent): validate gate misses
a class of input that runtime code handles. Fix at the gate
so both contracts agree.

## Slice

- `packages/scheduler/src/scheduler-helpers.ts` — added
  `!Number.isFinite(timeoutMs) ||` to the front of the
  existing range check in `validateExecutionTimeout`.
  Added a 5-line WHY comment explaining the NaN/Infinity
  trip-wire (comment policy: WHY, non-derivable from
  code).
- `packages/scheduler/src/scheduler-helpers.test.ts` —
  added one `it(...)` covering NaN, +Infinity, -Infinity
  rejection through the existing `validateExecutionTimeout`
  describe block.

## Verify

- New `it(...)` green; full `@muse/scheduler` suite green
  (81 passed, +1 vs baseline 80, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `!Number.isFinite(timeoutMs) ||` guard makes the new
  test fail with the precise pre-fix symptom — `NaN must
  reject — raw comparisons return false against any
  number, so the range check would silently pass it
  through to the runtime`. Fix restored, suite back to
  all green (81 passed).
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 1000 passed, packages/scheduler 81
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure validator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the
  `ScheduledJobValidator.validate` gate every scheduler
  create/update call hits, not the model loop.

## Status

Done. The scheduler validation gate now correctly rejects
non-finite `executionTimeoutMs`, matching the runtime
guard's `Number.isFinite` semantics. The validate-gate /
runtime-guard contract is now consistent across the
scheduler timeout path.

A sibling iteration target: `validateRetryConfig` has the
same shape (`maxRetryCount < 1` falsy for NaN, lets NaN
through). Deliberately deferred to a fresh iteration to
keep this iteration's scope tight; one validate gate per
commit.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all
P-bullets are already `[x]` and audited; a NaN-bypass
hardening on the scheduler validate gate, recorded
honestly with this backlog row — not a false metric.

## Decisions

- `Number.isFinite` is the precise predicate: rejects NaN,
  +Infinity, -Infinity (all of which slip past raw
  comparisons), accepts every other finite number. Same
  guard the matching runtime `resolveJobTimeout`
  already uses.
- The check is added BEFORE the range check rather than
  replacing it. Both filters compose: non-finite values
  reject for the finite reason; finite-but-out-of-range
  values reject for the range reason. The single thrown
  error message (`"must be 0 or between min and max"`)
  is fine for both branches — operators see a useful
  bound either way.
- Did NOT touch `validateRetryConfig` in this iteration
  even though it has the same `maxRetryCount < 1` shape
  that NaN slips past. Reason: one validate gate per
  commit, tight scope. Fresh iteration when the defect
  class comes up again.
- Did NOT touch the `normalizeScheduledJob` path. The
  `normalize` path already uses `Number.isFinite` for
  the same field via `typeof input.maxRetryCount ===
  "number" && Number.isFinite(input.maxRetryCount)` —
  the runtime guard is correct; only the validate gate
  was missing the finite check.
- Mutation reverts the precise delta (the `!Number.
  isFinite(timeoutMs) ||` prefix). Smallest semantic
  delta as one revert; surgical proof.
- The test covers NaN, +Infinity, AND -Infinity. NaN is
  the most common production cause (from arithmetic on
  bad inputs); +Infinity rarely shows up in serialised
  JSON (JSON doesn't represent it), but a programmatic
  caller could construct it. -Infinity round-trips as
  null in JSON, but again a programmatic caller could
  supply it. All three are rejected uniformly.
