# 664 — `validateRetryConfig` now bounds `maxRetryCount` on BOTH ends (integer in `[1, 100]`) so a scheduled job created with `maxRetryCount: 1_000_000` can't pass validation and turn `runWithRetry` into a retry-storm against the job's target — closes the asymmetry with the two-sided `validateExecutionTimeout` gate

## Why

`packages/scheduler/src/scheduler-helpers.ts:validateRetryConfig`
gated `maxRetryCount` with a lower bound only:

```ts
if (!Number.isFinite(maxRetryCount) || maxRetryCount < 1) {
  throw new SchedulerValidationError("maxRetryCount must be at least 1 ...");
}
```

Its sibling `validateExecutionTimeout` bounds BOTH ends
(`minExecutionTimeoutMs = 1_000` … `maxExecutionTimeoutMs =
3_600_000`). The retry gate was asymmetric — no ceiling.

A scheduled job created via the CLI / API with
`maxRetryCount: 1_000_000` (typo, copy-paste error, or
malicious config) passes validation. Then
`SchedulerRuntime.runWithRetry`:

```ts
const attempts = job.retryOnFailure ? Math.max(1, job.maxRetryCount) : 1;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try { return await this.dispatchByType(job); }
  catch (error) { ...; if (attempt < attempts) await this.sleep(this.retryDelayMs); }
}
```

…loops up to a million times, each iteration dispatching the
job (an LLM call, an MCP tool invocation, or an HTTP
request) with `retryDelayMs` sleep between. That's a
**retry-storm DoS** against:

- the local Ollama (a million failed generate calls),
- a remote MCP server (a million tool invocations),
- whatever endpoint the job's agent prompt reaches.

A failing job that should give up after 3 tries instead
hammers its target for hours or days.

The fix mirrors the executionTimeout's two-sided bound:
reject `maxRetryCount` outside `[1, maxRetryCountCeiling]`
where `maxRetryCountCeiling = 100`. Also tightened to
`Number.isInteger` (a retry COUNT is a whole number; the
prior `Number.isFinite` let `3.5` through, which then
truncated to 3 iterations in the loop — harmless but
inconsistent with the "count" semantic).

### Defect class

**Config-validation gate missing the upper range bound** —
first hit. Related to goal 650 (LLM timestamp sanity bound)
in being a value-range bound, but distinct domain
(scheduler retry config, not LLM output) and distinct
mechanism (a two-sided gate that was one-sided). Fresh
against the recent 10-iter window:

- 663: refactor DRY (route to shared embed)
- 662: mkdtempSync cleanup
- 661: concurrent RMW race
- 660: Promise.race timer leak
- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM)
- 655: path-traversal alt-separator
- 654: PKCE feature

## Slice

- `packages/scheduler/src/scheduler-helpers.ts`:
  - **New exported constant** `maxRetryCountCeiling = 100`
    (alongside the existing `defaultRetryCount = 3`).
  - `validateRetryConfig` now rejects when
    `!Number.isInteger(maxRetryCount) || maxRetryCount < 1
    || maxRetryCount > maxRetryCountCeiling`, with an error
    message naming the full `[1, 100]` range.
  - Updated the inline comment to explain the ceiling's
    retry-storm rationale.
- `packages/scheduler/src/scheduler-helpers.test.ts`:
  - Import updated to include `maxRetryCountCeiling`.
  - **Three new test cases**:
    1. **Ceiling** — `maxRetryCountCeiling` (100) accepted,
       `101` rejected, `1_000_000` rejected.
    2. **Non-integer** — `3.5` rejected, `3` accepted.
    3. **Constant pin** — `maxRetryCountCeiling === 100`.

## Verify

- `pnpm --filter @muse/scheduler test`: 91 passed (85 prior
  + the new cases). `pnpm check` full: every workspace
  green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the bound back to
  `!Number.isFinite(maxRetryCount) || maxRetryCount < 1`
  makes EXACTLY the ceiling test (1_000_000 / 101 slip
  through) AND the non-integer test (3.5 slips through)
  fail with the exact "expected function to throw, but it
  didn't" symptom. The pre-existing lower-bound + NaN /
  Infinity tests pass either way (those still throw under
  the reverted finite-check). Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. This is a
  pure config-validation gate. `smoke:live` doesn't apply.

## Status

Done. A retry-bomb config can no longer pass the create /
update gate:

| `maxRetryCount` (retryOnFailure=true)        | Pre-fix              | Post-fix                          |
| -------------------------------------------- | -------------------- | --------------------------------- |
| `3` (default)                                | accepted             | accepted                          |
| `0` / `-1`                                   | rejected             | rejected                          |
| `NaN` / `Infinity`                           | rejected             | rejected                          |
| `100` (ceiling)                              | accepted             | accepted                          |
| `101`                                        | **accepted**         | **rejected** (fixed)              |
| `1_000_000` (retry bomb)                     | **accepted → 1M dispatch attempts** | **rejected** (fixed) |
| `3.5` (non-integer)                          | **accepted → truncates to 3** | **rejected** (fixed)     |

## Decisions

- **Ceiling = 100**. Generous against any legitimate
  scheduled-job retry need (most production retry policies
  cap at 3-10) while bounding the worst case. A job that
  genuinely needs more than 100 retries should reconsider
  its design (it's likely failing for a non-transient
  reason). Mirrors the executionTimeout's "generous but
  bounded" 1h ceiling.
- **`Number.isInteger`, not `Number.isFinite`**. A retry
  COUNT is conceptually a whole number. The prior finite
  check let `3.5` through, which `Math.max(1, 3.5)` and
  the `attempt <= 3.5` loop quietly treated as 3 — correct
  by accident but inconsistent with the field's semantic.
  The error message now says "must be an integer".
- **Exported the constant** so the API / CLI surfaces (and
  the dynamic-scheduler tool) can reference the same
  ceiling in their own validation / help text, and the
  test pins it.
- **Did NOT clamp in `normalizeScheduledJob`**. The
  validate gate is the create/update contract — new jobs
  can't carry an out-of-range count. A job persisted
  BEFORE this fix with `maxRetryCount: 1e9` would still
  load via normalize (which passes finite values through)
  and run unbounded. Clamping in normalize would be
  defense-in-depth for legacy rows; deferred to a sibling
  iter to keep this change focused on the gate.
- **Mutation choice**. Reverted the integer + ceiling
  check back to the finite + lower-bound check. The
  ceiling and non-integer tests fail; the lower-bound /
  NaN / Infinity tests pass regardless. Surgical proof.

## Remaining risks

- **Legacy persisted jobs**: a `scheduled_jobs` row written
  before this fix with `maxRetryCount > 100` survives in
  the DB and `normalizeScheduledJob` passes it through to
  `runWithRetry`. A migration or a normalize-time clamp
  (`Math.min(maxRetryCountCeiling, ...)`) would close this;
  deferred to a sibling iter. New jobs are bounded.
- **`retryDelayMs` is fixed, not exponential-backoff**.
  Even 100 retries with a small delay could hammer a
  target. The ceiling bounds the count; a separate iter
  could add backoff (the runtime already sleeps
  `retryDelayMs` between attempts). Out of scope.
- **The ceiling isn't env-configurable**. An operator who
  legitimately needs more than 100 retries must edit the
  constant. Future iter could wire
  `MUSE_SCHEDULER_MAX_RETRY_COUNT` through if needed.
- **`dynamic-scheduler.ts:361`** reads `maxRetryCount` via
  `readOptionalNumber` and feeds it into the same
  validate gate, so the dynamic (MCP-tool-driven) job
  creation path is also bounded — verified the gate is the
  single chokepoint.
