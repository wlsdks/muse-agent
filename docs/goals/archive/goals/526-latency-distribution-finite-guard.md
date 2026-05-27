# 526 — `latencyDistribution` routes NaN latency to `unknown` instead of silently inflating the `30s+` bucket (goal-511/512/518 sibling on the compat run-history aggregation)

## Why

`apps/api/src/compat-run-aggregations.ts:152` computed the
admin run-history latency-distribution buckets by subtracting
two Dates with no finite-result guard:

```ts
const latencyMs = run.completedAt.getTime() - run.startedAt.getTime();
if (latencyMs < 1_000) { buckets["0-1s"] += 1; }
else if (latencyMs < 5_000) { buckets["1-5s"] += 1; }
else if (latencyMs < 30_000) { buckets["5-30s"] += 1; }
else { buckets["30s+"] += 1; }
```

The early-return at line 156-159 already filters runs with
`startedAt` or `completedAt` strictly missing (`!run.startedAt`),
but it doesn't filter Invalid-Date instances. A run whose
`startedAt` or `completedAt` is an Invalid Date (e.g. a DB row
where one column is corrupted, a clock-skew rewind that produces
NaN, or a `new Date(undefined)` somewhere upstream) passes the
truthy-check **but** produces `NaN - finite = NaN` or
`NaN - NaN = NaN`.

`NaN < 1_000` / `NaN < 5_000` / `NaN < 30_000` are **all false**.
So a corrupted run silently falls through to the `else` branch
and is **counted as `30s+`** — a slow-request signal.

The admin observability path consumes this distribution
(`/admin/observability/latency`). A single corrupt run inflates
the "slow request" count by 1, skewing the operator's latency
view. With multiple corrupted rows, the operator sees a phantom
slow-request spike with no real cause.

Same `??`/finite-guard defect class as goals 511 / 512 / 518 —
NaN propagating through arithmetic. The convention has landed
on scheduler executions (511), observability token-cost INSERT
(512), and multi-agent orchestration summary (518); the
compat-run-aggregations latency distribution was the remaining
outlier on the same defect class.

## Slice

- `apps/api/src/compat-run-aggregations.ts` — added the
  `!Number.isFinite(latencyMs)` branch immediately after the
  subtraction, routing NaN/Infinity to the existing `unknown`
  bucket:
  ```ts
  if (!Number.isFinite(latencyMs)) {
    buckets.unknown += 1;
  } else if (latencyMs < 1_000) {
    buckets["0-1s"] += 1;
  } else …
  ```
  Behaviour byte-identical for every clean finite latency; only
  the NaN/Infinity path now goes to `unknown` instead of `30s+`.
- `apps/api/test/compat-run-aggregations.test.ts` — new file, 3
  focused tests covering:
  - clean spread across all four finite buckets (0-1s, 1-5s,
    5-30s, 30s+) — pins the happy path
  - missing startedAt or completedAt → unknown (existing
    contract from line 156-159)
  - Invalid Date subtraction → NaN → unknown (the defect this
    iteration closes)

## Verify

- New tests 3/3 green; full `@muse/api` suite green (236
  passed, +3 vs baseline 233, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  finite-guard branch makes the NaN-bucketing test fail with
  the precise pre-fix symptom — `NaN latency must NOT inflate
  the 30s+ bucket; it belongs in unknown: expected +0 to be
  3` (the three NaN-latency runs silently classified as `30s+`
  instead of `unknown`). Every other test stays green. Fix
  restored, suite back to 3 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure aggregation — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the
  `/admin/observability/latency` distribution shown to the
  operator, not the model loop.

## Status

Done. A corrupted run-history record with an Invalid Date
no longer inflates the operator's `30s+` slow-request bucket
by 1. The finite-guard convention now covers four sibling
sites consistently:

- scheduler execution-log durationMs (511)
- observability token-cost INSERT row (512)
- multi-agent orchestration-history summary (518)
- compat run-history latency distribution (this goal)

Each defends the consumer (aggregator/UI) from upstream
NaN/Infinity corruption with a single `Number.isFinite()`
check.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry robustness
`fix:` on the compat run-history latency distribution,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the surrogate-cap run (524 / 525) to
  the `??`/finite-guard NaN class on a different surface (API
  compat run-history aggregation). Productive variation, not
  same-area churn.
- Routed NaN to the existing `unknown` bucket rather than
  introducing a new "corrupt" label: `unknown` already exists
  for "missing startedAt or completedAt" runs (line 156-159);
  semantically, "I can't compute a latency for this run" is
  the same answer whether the Date is missing or invalid.
  Operators reading the distribution see one consistent
  bucket name. Mirrors goal 509's `(invalid)` UI-sentinel
  decision — surface the unmeasurable as a single recognisable
  state.
- Did NOT touch the early-return at line 156-159 (`!run.
  startedAt || !run.completedAt`): that filter is correct for
  what it tests (missing fields). Adding a `Number.isFinite`
  check there would be a behaviour change for `new Date(NaN)`
  vs. `undefined`; cleaner to defend at the subtraction
  boundary where NaN actually appears.
- The mutation reverts the `!Number.isFinite` branch (4 lines)
  rather than restoring the whole pre-fix order: the test
  failure (`expected +0 to be 3`) reproduces the pre-fix
  observable byte-for-byte — three NaN runs silently
  classified as `30s+` instead of `unknown`.
- Created a fresh `compat-run-aggregations.test.ts` file
  rather than threading the case into an existing test file:
  the function had zero direct test coverage before this
  iteration, and a dedicated file makes the contract visible
  for future maintainers.
