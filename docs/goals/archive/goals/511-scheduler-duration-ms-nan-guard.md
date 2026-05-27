# 511 — `normalizeScheduledJobExecution` durationMs no longer accepts NaN / Infinity (goal-428/436/437/443/479 sibling on the persisted scheduled-execution log)

## Why

`packages/scheduler/src/scheduler-helpers.ts:201` normalised the
`durationMs` field of every persisted scheduled-job execution
with the classic `??`-shadow:

```ts
durationMs: input.durationMs ?? 0,
```

`??` short-circuits on `null` / `undefined` only — it does **not**
catch `NaN` or `±Infinity`. The dynamic scheduler computes
duration as:

```ts
durationMs: this.now().getTime() - startedAt.getTime(),
```

If `startedAt` is an Invalid Date (e.g. loaded from a corrupted
sidecar or an upstream `new Date(badValue)` that wasn't pre-
guarded), `startedAt.getTime()` is `NaN` and the subtraction is
`NaN`. The `?? 0` keeps the `NaN` intact; the execution log
silently persists `NaN` (or whatever the DB driver coerces NaN
into — usually `NULL` or `0`). Downstream consumers querying
`/scheduler/executions` would see a phantom 0-duration job that
actually ran for an unknown length of time. Worse: a follow-up
`AVG(duration_ms)` rollup would silently skew when half the
rows are NULL/0.

Same `??`-doesn't-catch-NaN defect class as goals 428 / 436 /
437 / 443 / 479. The convention has landed on
`agent-core` / `memory` / `messaging` paths; the scheduler's
execution-log normalisation was the remaining outlier.

`normalizeScheduledJobExecution` previously had **zero direct
unit tests** — coverage was only via `InMemoryScheduledJob
ExecutionStore.save` integration tests, which never hand-built
a `NaN` durationMs to falsify the guard.

## Slice

- `packages/scheduler/src/scheduler-helpers.ts` — swap the
  shadow:
  ```ts
  durationMs: typeof input.durationMs === "number"
    && Number.isFinite(input.durationMs) ? input.durationMs : 0,
  ```
  Behaviour byte-identical for every clean finite number,
  zero, and `undefined`. Only `NaN` / `±Infinity` paths now
  fall back to `0` instead of propagating.
- `packages/scheduler/src/scheduler-helpers.test.ts` — added
  a `describe("normalizeScheduledJobExecution durationMs guard")`
  block with 4 focused tests:
  - preserves a clean finite durationMs (1234, 0)
  - falls back to 0 when `undefined` (existing behaviour
    pinned)
  - falls back to 0 when `NaN` — the defect this iteration
    closes
  - falls back to 0 when `±Infinity` (runaway clock-skew
    defence)

## Verify

- New test 4/4 green; full `@muse/scheduler` suite green
  (80 passed, +4 vs baseline 76, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the guard
  to `input.durationMs ?? 0` makes 2 tests fail with the
  precise pre-fix symptoms:
  - `expected NaN to be +0` — `NaN ?? 0` is `NaN`
  - `expected Infinity to be +0` — `Infinity ?? 0` is `Infinity`
  Every other test stays green. Fix restored, suite back to
  4 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure normaliser — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the persisted scheduler
  execution-log, not the model loop.

## Status

Done. A scheduled-job execution whose `durationMs` is `NaN`
(corrupted upstream `startedAt`, runaway clock-skew, hand-
edited sidecar) no longer silently persists `NaN` to the
execution log and skew downstream `AVG(duration_ms)` rollups.
The `??`-doesn't-catch-NaN convention now covers six sibling
sites consistently: agent-core's response-cost, memory's
ranking-score, messaging's retry-delay, scheduler's execution-
log durationMs. The scheduler-helpers test file now provides
the first direct coverage of `normalizeScheduledJobExecution`.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry robustness
`fix:` + direct-coverage on the scheduler execution-log
normaliser, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Step-8 redirect from the finite-Date guard run (508 / 509 /
  510) to a different defect class (`??`-doesn't-catch-NaN)
  on a different surface (scheduler execution log).
  Productive variation, not same-area churn.
- Used `typeof input.durationMs === "number" && Number.isFinite
  (input.durationMs)` rather than `Number.isFinite(input.
  durationMs)` alone: TypeScript's `Number.isFinite` type-
  predicate signature does NOT narrow `number | undefined` to
  `number` in the codebase's current lib version, so the
  ternary's true-branch was a type error without the typeof
  guard. The two-step check is the established cross-package
  pattern (see `personal-status-summary.ts` line 185) for the
  same reason.
- Did NOT clamp negative durationMs to 0: negative durations
  are a real signal of clock drift (a job that "finished
  before it started" by NTP correction) and the operator
  should see them as-is in the execution log, not silently
  zeroed. NaN/Infinity are different — they are not a signal,
  they're a calculation failure.
- The mutation reverts to the original `?? 0` line (not e.g.
  removing the field entirely) because that's the exact pre-
  fix code; the test failures (`NaN to be +0`, `Infinity to
  be +0`) reproduce the pre-fix behaviour byte-for-byte.
- Caught a typo'd `"succeeded"` (not a valid `JobExecution
  Status`) during the type-check sweep; corrected to
  `"success"`. Self-test of the verification gate working as
  intended.
