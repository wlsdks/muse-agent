# 485 — direct coverage for `resolveJobTimeout` (test-only; 458/477/479/480 class)

## Why

`resolveJobTimeout` (`@muse/scheduler` `scheduler-helpers.ts:120`)
is the safety chokepoint that decides how long a scheduled job
gets to run. Its result feeds **two** scheduler hot paths:

- the **distributed lock TTL** (`Math.max(min, value)` — a
  `NaN` here propagates and the lock has no expiry).
- the **execution watchdog** (`setTimeout(value, ...)` — Node
  coerces `NaN` to `0`, instantly aborting the job).

The function defends against both by clamping non-finite or
non-positive values to a fallback — the existing `Number.isFinite
&& value > 0` guard is explicitly documented to catch a "corrupt
persisted `executionTimeoutMs`" the `??`-fallback can't. But the
**defense itself was untested**: no
`packages/scheduler/test/*timeout*.test.ts`, no other
scheduler-helpers test imported `resolveJobTimeout`. A
"simplification" PR that dropped the `Number.isFinite` clamp
would silently turn a corrupt row into either:

- a job watchdog that fires at t+0 (every scheduled run aborts
  before any work happens), or
- a lock with no TTL (a crashed/hung worker permanently locks
  the row).

The proven `??`-doesn't-catch-NaN defect class (428/436/437/443).
Same 458/477/479/480 sanctioned class as goal 479
(`StepBudgetTracker`) — a real safety-critical zero-coverage
helper with a non-trivial guard contract, mutation-provable. No
`.ts` source change.

## Slice

- `packages/scheduler/src/scheduler-helpers.test.ts` — extended
  (existing 21 tests untouched) with a focused
  `resolveJobTimeout` describe: explicit positive value
  returned; undefined falls back; **NaN falls back** (the `??`
  hole this function exists to plug); Infinity / negative /
  zero all fall back.
- `packages/scheduler/src/scheduler-helpers.ts` — **unchanged**
  (`git diff --stat` empty; test-only iteration mirroring goals
  458/477/479/480 verbatim).

## Verify

- New 4 tests green; the 21 pre-existing scheduler-helpers
  tests still green (no wrong premise — none asserted the
  timeout-defense behaviour); full `@muse/scheduler` suite
  green (existing 65 → 69 with the +4; per-pkg run shows 25
  passed in this file); tsc strict (scheduler) EXIT=0.
- **Clean-mutation-proven** (Edit-based): weakening the guard
  to a plain `return job.executionTimeoutMs ?? fallbackMs`
  makes the NaN and Infinity tests fail with the precise
  pre-defense symptoms (`expected NaN to be 60000` and
  `expected Infinity to be 60000` — the corrupt values
  propagating to the watchdog `setTimeout(NaN)` / lock TTL
  `Math.max(min, Infinity)`) while the explicit-value /
  undefined-fallback tests stay green; source restored
  byte-identical, suite back to 4 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended test file (src is unchanged).
- Pure deterministic value resolution — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The scheduler's runtime safety budget — the value every
job-watchdog `setTimeout` and every distributed-lock TTL is
computed from — now has direct coverage that pins the
NaN/Infinity/negative/zero defense; the central `Number.isFinite
&& > 0` clause is mutation-proven against the `??`-only
weakening.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458/477/479/480-class direct
coverage addition on a zero-coverage safety-critical helper,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from apps/cli (4 of last 5 commits were
  cli/autoconfigure) to `@muse/scheduler` — distinct package
  AND distinct defect class (`??`-doesn't-catch-NaN safety
  guard vs. empty-env-shadow / counter-divisor consistency).
- Mutation-proved by removing the entire `Number.isFinite && > 0`
  clause (not by edge-tweaks): a future "simplification" PR is
  the realistic regression vector here, and the simpler-form
  `return value ?? fallback` is exactly the shape that PR
  would propose; the test catches it directly.
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `scheduler-helpers.ts`) —
  mirrors the 458/477/479/480 protocol exactly.
