# 487 — direct coverage for `computeApproximateTokens` + `createApproximateTokenEstimator` (test-only; 458/477/479/480/485 class)

## Why

`token-estimator.ts` (`@muse/memory`) is the **token-budget
oracle** every context-trimming and budget-enforcement path
calls into:

- `memory-token-trim.ts` decides whether a conversation segment
  fits the cap.
- The agent runtime's `StepBudgetTracker` (goal 479) reports
  cumulative tokens against the budget — those cumulative
  numbers come from this estimator on each turn.
- `tool-output-importance.ts` budgets the tool-output context
  block.

So a regression in the bucket ratios (Latin / CJK / Emoji /
Other) — or in the **`Math.max(1, total)` floor** that
guarantees every non-empty input bills at least one token —
silently inflates or deflates every budget decision across the
runtime.

The module had **zero direct test coverage**: no
`packages/memory/test/token-estimator*.test.ts`, and no other
memory test imports it. Its contract (empty → 0; non-empty →
≥1; Latin/4; CJK = `floor((chars*2+1)/3)`; emoji 1:1; other/3;
cache-hit deterministic; FIFO eviction at `maxEntries`) was
implicit-only. A "simplification" PR that dropped the
`Math.max(1, ...)` floor — the easy regression vector — would
return `0` for any short Latin input like `"a"`, silently
breaking the budget gate's invariant that every billable text
costs at least one token.

The same 458/477/479/480/485 sanctioned class: real
safety-budget zero-coverage helper, multi-clause contract,
mutation-provable. No `.ts` source change.

## Slice

- `packages/memory/test/token-estimator.test.ts` — new file, 9
  focused tests:
  - **bucket ratios** — empty → 0; any non-empty → ≥1; Latin
    `4 chars / token`; CJK `floor((chars*2+1)/3)`; emoji `1:1`;
    mixed-bucket sum (no rounding leak).
  - **cache + TTL** — repeated query is byte-equal; isolated
    estimators don't share state; FIFO eviction at
    `maxEntries` doesn't leak / throw.
- `packages/memory/src/token-estimator.ts` — **unchanged**
  (`git diff --stat` empty; test-only iteration mirroring goals
  458/477/479/480/485 verbatim).

## Verify

- New test 9/9 green; full `@muse/memory` suite green (176
  passed, +9, 0 failed); tsc strict (memory) EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  `Math.max(1, ...)` floor makes the two "never returns 0 for
  any non-empty input" assertions fail with the precise pre-
  defense symptom (`expected 0 to be 1` — `"a"` would bill 0
  tokens, breaking the budget gate's invariant that every
  billable text costs at least one token) while the other 7
  tests stay green; source restored byte-identical, suite back
  to 9 green.
- `pnpm check` EXIT=0, every workspace green — no regression;
  `pnpm lint` 0/0; `pnpm guard:core` clean (no IMMUTABLE-CORE
  touched); byte-scan clean; `git status` shows only the one
  intended test file (src is unchanged).
- Pure deterministic estimation — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. The token-budget oracle — the function every trim /
budget / step-budget path queries — now has direct coverage
that pins its bucket ratios, the `Math.max(1, ...)`
non-zero-billing floor, and the cache semantics; the floor
clause is mutation-proven against the easy
"simplify-away-the-Math.max" regression.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 458-class direct coverage addition
on a zero-coverage budget-critical helper, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Distinct area from the recent apps/cli runs (`@muse/memory`).
- Mutation-proved the `Math.max(1, ...)` floor specifically
  rather than the bucket ratios: the floor is the
  *easy-regression* clause (a future "simplification" PR would
  argue "`Math.max(1, x)` is redundant when x ≥ 1" and drop
  it, not realising that empty-after-bucketing inputs return
  0); the bucket ratios are pinned positively by the explicit
  numeric assertions for each bucket.
- Test-only (no source change); source restored byte-identical
  (`git diff --stat` empty for `token-estimator.ts`) — mirrors
  the 458/477/479/480/485 protocol exactly.
