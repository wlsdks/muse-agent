# 479 — direct coverage for `StepBudgetTracker` (test-only; 458/460/462/477 class)

## Why

`StepBudgetTracker` (`@muse/agent-core` `step-budget.ts`) is the
**agent-run token budget gate** — every step of every agent run
funnels through `trackStep(...)` / `status()` to decide whether
to keep going (`ok`), wind down to a direct answer
(`soft_limit`), or stop (`exhausted`). It's the runtime's
deterministic safety budget — if it returns the wrong status at
the soft-limit boundary, the agent either burns through tokens
past the wind-down point or stops early when it shouldn't.

It had **zero direct test coverage**: no
`packages/agent-core/test/step-budget*.test.ts`, and no other
agent-core test imported the module. Its multi-axis contract
(ctor validation; non-blank step + non-negative finite tokens
guards; `>=` exact-boundary semantics for soft and hard limits;
accumulation; `Math.floor` softLimit derivation; `remaining`
clamping at 0; `recordToolOutput` delegation; ordered `history`)
was implicit-only — a regression on the safety-gate boundary
would silently pass code review with the rest of the suite
green.

This is the same 458/460/462/477 sanctioned class: a real
safety-critical zero-coverage path where the contract is
non-trivial and several clauses are mutation-provable. No `.ts`
source change.

## Slice

- `packages/agent-core/test/step-budget.test.ts` — new file, 10
  focused tests:
  - **constructor validation** — rejects `maxTokens ≤ 0` / NaN /
    Infinity; rejects `softLimitPercent` outside (0,100).
  - **trackStep input guards** — blank label and negative / NaN
    / Infinity token counts both throw with the documented
    error messages.
  - **status thresholds (exact-boundary semantics)** — `ok`
    strictly below the soft limit; `soft_limit` at cumulative
    `==` soft (the `>=` boundary); `exhausted` at cumulative
    `==` max; custom `softLimitPercent` honoured with
    `Math.floor(maxTokens * pct / 100)`.
  - **accessors** — `recordToolOutput` delegates to `trackStep`;
    `remaining` clamps at 0 after overrun; `history` records
    each step in order with its post-step status.
- `packages/agent-core/src/step-budget.ts` — **unchanged**
  (`git diff --stat` empty; test-only iteration mirroring goals
  458/460/462/477 verbatim).

## Verify

- New test 10/10 green; full `@muse/agent-core` suite green
  (605 passed, +10, 0 failed); tsc strict (agent-core) EXIT=0.
- **Clean-mutation-proven** (Edit-based): weakening the soft
  limit comparison from `>=` to `>` makes the boundary tests
  fail with the precise pre-fix symptom (`expected 'ok' to be
  'soft_limit'` — agent runs would silently fly past the
  wind-down signal at the exact boundary token count) while
  the other 8 tests stay green; source restored byte-identical,
  suite back to 10 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended test file (src is unchanged).
- Pure deterministic budget logic — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The agent-run safety-budget gate — every step of every
agent run reports `ok` / `soft_limit` / `exhausted` through this
class — now has direct coverage that pins its construction
validation, input guards, exact-boundary thresholds, and
accessor contracts; the soft-limit boundary clause is
mutation-proven.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458/460/462/477-class direct
coverage addition on a zero-coverage safety-critical helper,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Distinct package + axis from the recent run (apps/cli
  autoconfigure wire-path + cross-package registry-hint slice):
  agent-core's runtime safety gate is genuinely different
  territory (Step-8 redirect).
- Mutation-proved the **soft-limit boundary** (`>=`) rather
  than the hard `exhausted` boundary: the soft limit is the
  *operator-configurable* knob (`softLimitPercent`, default 80)
  and its exact-boundary semantics are the non-obvious clause
  the next author would be most likely to weaken to `>` "for
  consistency with stop"; the hard limit's `>=` is implicitly
  proved by the same chain of tests.
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `step-budget.ts`) — mirrors the
  458/460/462/477 protocol exactly.
