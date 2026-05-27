# 665 — `ScheduledJobDispatcher.runWithRetry` clamps its dispatch loop to `[1, maxRetryCountCeiling]` (and treats a non-finite count as a single attempt) so a legacy / hand-edited DB row carrying an unbounded `maxRetryCount` can't become a retry-storm — the execution-layer defense goal 664's remaining-risks deferred

## Why

Goal 664 added the create/update gate
(`validateRetryConfig` bounds `maxRetryCount` to
`[1, 100]`). Its Remaining Risks explicitly deferred the
execution-layer defense:

> Legacy persisted jobs: a `scheduled_jobs` row written
> before this fix with `maxRetryCount > 100` survives in
> the DB and `normalizeScheduledJob` passes it through to
> `runWithRetry`. A migration or a normalize-time clamp
> would close this; deferred to a sibling iter.

The gate only runs at job create / update. But
`runWithRetry` is the actual execution point, and it
trusted `job.maxRetryCount` verbatim:

```ts
const attempts = job.retryOnFailure ? Math.max(1, job.maxRetryCount) : 1;
for (let attempt = 1; attempt <= attempts; attempt += 1) { ... }
```

Three ways an out-of-range count reaches this loop despite
the gate:

1. **Legacy DB rows** — a job persisted by a Muse version
   before goal 664 carries `maxRetryCount: 1_000_000`.
   `normalizeScheduledJob` passes finite values through
   unchanged, so the stale row loads and runs.
2. **Hand-edited / migrated DB** — an operator or a
   migration script writes a row directly, bypassing the
   validate gate.
3. **Non-finite from a corrupt row** —
   `maxRetryCount: Infinity` makes `Math.max(1, Infinity)`
   = `Infinity`, and `for (attempt = 1; attempt <=
   Infinity; ...)` is an **infinite loop** that never
   terminates — a hard hang of the scheduler tick.

In cases 1-2 the loop dispatches the job (LLM / MCP tool /
HTTP) up to a million times — a retry-storm. In case 3 the
scheduler tick hangs forever.

The fix clamps at the execution boundary, mirroring the
gate's `[1, maxRetryCountCeiling]` bound and collapsing a
non-finite count to a single attempt:

```ts
const attempts = job.retryOnFailure
  ? Math.min(maxRetryCountCeiling, Math.max(1, Number.isFinite(job.maxRetryCount) ? Math.trunc(job.maxRetryCount) : 1))
  : 1;
```

Now the gate (goal 664) and the runtime (this iter) both
enforce the bound — defense in depth at the trust
boundary.

### Defect class

**Execution-layer trust-boundary clamp (runtime defends
against out-of-range persisted config)**. Adjacent to goal
664 (same `maxRetryCount` field, same ceiling constant)
but a distinct layer and a distinct bug: 664 was the
create-time *validation gate*; this is the *execution-time
defense* against rows the gate never saw. The infinite-loop
case (non-finite → `attempt <= Infinity`) is a hard hang
that the validation gate alone never prevented for
pre-existing rows. Closes the documented remaining-risk of
664.

## Slice

- `packages/scheduler/src/index.ts`:
  - Imported `maxRetryCountCeiling` from
    `./scheduler-helpers.js`.
  - `ScheduledJobDispatcher.runWithRetry` clamps `attempts`
    to `Math.min(ceiling, Math.max(1, isFinite ?
    trunc(count) : 1))`. A WHY comment explains the
    legacy-row threat (the validate gate can't protect
    rows that predate it).
- `packages/scheduler/test/scheduler.test.ts`:
  - **Two new tests** in the `ScheduledJobDispatcher`
    describe:
    1. **Unbounded count clamps to ceiling** — a job with
       `maxRetryCount: 1_000_000` (a raw `ScheduledJob`
       object that bypasses the validate gate) + an
       always-failing executor. Asserts the executor is
       called exactly 100 times (the ceiling), not a
       million.
    2. **Non-finite count → single attempt** — a job with
       `maxRetryCount: Infinity`. Asserts exactly 1
       dispatch. Pre-fix this was an infinite loop.

## Verify

- `pnpm --filter @muse/scheduler test`: 93 passed (91 prior
  + 2 new). `pnpm check` full: every workspace green; tsc
  strict EXIT=0.
- **Clean-mutation-proven**: reverting the clamp back to
  `Math.max(1, job.maxRetryCount)` makes the non-finite
  test **hang forever** (`for (attempt = 1; attempt <=
  Infinity; ...)` never terminates) — I confirmed with a
  hard `timeout 30` that the reverted test never completes,
  the exact infinite-loop symptom the clamp prevents. The
  unbounded-count test would also fail (1M dispatches vs
  expected 100). Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. The retry
  loop dispatches jobs but the test stubs the executor.
  `smoke:live` doesn't apply.

## Status

Done. Both the create gate (664) and the dispatch loop
(665) now bound the retry count:

| Path                                          | maxRetryCount = 1_000_000              | maxRetryCount = Infinity              |
| --------------------------------------------- | -------------------------------------- | ------------------------------------- |
| Create / update via gate (664)               | rejected at validate                   | rejected at validate                  |
| Legacy DB row → runWithRetry (pre-665)        | **1M dispatches (retry-storm)**        | **infinite loop (tick hangs)**        |
| Legacy DB row → runWithRetry (post-665)       | 100 dispatches (ceiling)               | 1 dispatch (non-finite → single)      |

## Decisions

- **Clamp at the dispatcher, not in `normalizeScheduledJob`**.
  Two reasons: (1) the dispatcher is the single execution
  chokepoint — every retry path flows through it,
  regardless of how the job was loaded (DB, in-memory,
  test); (2) clamping in normalize would mutate the stored
  value, which could surprise an operator reading the row
  back via `muse scheduler list` (they'd see 100 where
  they wrote 1e6). The dispatcher clamp bounds the
  *behavior* without rewriting the *data*.
- **Non-finite → 1 attempt, not the ceiling**. A corrupt
  / NaN / Infinity count signals a broken row; the safe
  default is "try once, then give up" — not "retry 100
  times". `Math.max(1, isFinite ? trunc : 1)` collapses
  any non-finite to 1.
- **`Math.trunc`** for finite non-integers — a row with
  `maxRetryCount: 3.7` dispatches 3 times, consistent with
  the gate's integer requirement (664) and the loop's
  `attempt <= attempts` semantics.
- **Reused `maxRetryCountCeiling`** from goal 664 rather
  than a second constant — the gate and the runtime
  enforce the same number; a future change to the ceiling
  updates both.
- **Mutation choice**. Reverted to the bare `Math.max(1,
  job.maxRetryCount)`. The non-finite test hangs forever
  (infinite loop) — proven with a hard process timeout —
  and the unbounded test would dispatch 1M times. The
  fix clamps both. Surgical proof of the execution-layer
  defense.

## Remaining risks

- **`retryDelayMs` between attempts is fixed, not
  exponential backoff**. 100 retries with a small delay
  could still hammer a target over a short window. The
  count is bounded now; backoff is a separate concern —
  a future iter could add exponential backoff to the
  dispatcher's `sleep`.
- **The ceiling isn't env-configurable** (noted in 664).
  Both the gate and the dispatcher reference the same
  hardcoded constant.
- **A row with `maxRetryCount: 100` (exactly the ceiling)
  + a job that always fails** still dispatches 100 times.
  That's the intended generous bound — an operator who
  set 100 retries gets 100. If the target is down, the
  job consumes 100 dispatch slots before giving up; the
  scheduler's per-job execution timeout (`withTimeout`
  around `runWithRetry`) caps the total wall-clock.
- **`normalizeScheduledJob` still stores the raw value**.
  A `muse scheduler list` shows the original (possibly
  out-of-range) count even though execution clamps it.
  A cosmetic display clamp or a one-time migration could
  reconcile the stored value with the enforced bound —
  deferred, low priority (the behavior is now safe
  regardless of the displayed number).
