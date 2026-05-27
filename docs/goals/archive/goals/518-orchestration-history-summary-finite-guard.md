# 518 — `OrchestrationHistoryStore.summary()` ignores NaN/Infinity durations (goal-511/512 sibling on the multi-agent run-history aggregate)

## Why

`packages/multi-agent/src/orchestration-history.ts:125`
computed the orchestration-run summary by sorting and summing
**every** entry's `durationMs` straight through:

```ts
const sortedDurations = [...this.entries.map((entry) => entry.durationMs)].sort((a, b) => a - b);
const totalDuration = sortedDurations.reduce((sum, value) => sum + value, 0);
…
avgDurationMs: Math.round(totalDuration / sortedDurations.length),
…
maxDurationMs: sortedDurations[sortedDurations.length - 1] ?? 0,
minDurationMs: sortedDurations[0] ?? 0,
p95DurationMs: sortedDurations[p95Index] ?? 0,
```

`store.record(entry)` has **no validation** on `durationMs`. The
orchestrator computes it as `finishedAt.getTime() - startedAt.
getTime()`; if either Date is Invalid (a clock-rewind, a corrupt
upstream timestamp from a multi-process scenario, a hand-edited
sidecar), `durationMs` is `NaN`. A single poisoned row then:

- `NaN` sort: `(a, b) => NaN - NaN` is `NaN`, treated as 0 by
  `Array.prototype.sort` → undefined ordering, NaN survives at
  some index.
- `reduce((sum, value) => sum + value, 0)`: `0 + 100 + NaN + …`
  → `NaN`.
- `Math.round(NaN / n)` → `NaN`.
- Same NaN propagates into `byMode.{sequential,parallel,race}.
  avgDurationMs`.
- `min/max/p95` index into the (NaN-containing) sortedDurations
  → potentially NaN.

The result: **a single corrupted row poisons every aggregate in
the orchestration summary** — operators inspecting `muse
orchestrate stats` or `/api/multi-agent/orchestrations/stats`
see all-NaN, with no hint of which row caused it.

Same `??`-doesn't-catch-NaN defect class as goals 428 / 436 /
437 / 443 / 479 / 511 / 512. The convention has landed on
scheduler execution-log (511) and observability token-cost
(512); the multi-agent orchestration history was the
remaining outlier in this family on a runtime-hot path.

## Slice

- `packages/multi-agent/src/orchestration-history.ts` — the
  `summary()` computation now filters durations through
  `Number.isFinite` before sort/sum/avg/p95:
  ```ts
  const finiteDurations = this.entries
    .map((entry) => entry.durationMs)
    .filter((ms): ms is number => Number.isFinite(ms));
  const sortedDurations = [...finiteDurations].sort((a, b) => a - b);
  ```
  Replaced the three duplicated `byMode` reductions with one
  helper `byModeAvg(mode)` that filters the same way before
  averaging. The `runs:` count remains a count of entries with
  that mode (including poisoned-duration rows — they still
  *happened*, they just don't contribute to the mean).
  `avgDurationMs` now guards against a zero divisor:
  `sortedDurations.length === 0 ? 0 : Math.round(totalDuration / sortedDurations.length)`.
- `packages/multi-agent/test/orchestration-history.test.ts` —
  added one new `it(...)` block that records four entries
  (two clean, one NaN, one Infinity) and asserts:
  - `totalRuns` counts all four (entries aren't dropped)
  - `avgDurationMs` is finite
  - `avgDurationMs` is 200 (clean avg, not poisoned)
  - `minDurationMs` = 100, `maxDurationMs` = 300,
    `p95DurationMs` = 300 (all from the two finite rows)
  - `byMode.sequential.avgDurationMs` = 100 (avg of finite),
    `byMode.sequential.runs` = 2 (count of all)
  - `byMode.parallel.avgDurationMs` = 300, `runs` = 2

Behaviour byte-identical when every row has a finite duration —
the existing summary-aggregation test passes unchanged. Only the
NaN / Infinity poison path now produces finite, meaningful
aggregates.

## Verify

- New test 1 `it` block × 11 assertions = all green; full
  `@muse/multi-agent` suite green (47 passed, +1 vs baseline
  46, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the finite
  filter back to a bare `[...this.entries.map((entry) =>
  entry.durationMs)].sort(...)` makes the new test fail with
  the precise pre-fix symptom — `avgDurationMs (NaN) must be
  finite: expected false to be true` (NaN propagates from one
  poisoned row into every aggregate). Every other test stays
  green. Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint` 0/0;
  `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure aggregation — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the
  `/api/multi-agent/orchestrations/stats` and `muse
  orchestrate stats` consumers, not the model loop.

## Status

Done. A poisoned orchestration entry (NaN duration from an
Invalid-Date subtraction, Infinity from a runaway clock-skew,
hand-edited sidecar) no longer collapses the whole summary into
NaN. The cross-package `??`-doesn't-catch-NaN convention now
covers seven sibling sites:

- agent-core response-cost (428 / 436 / 437 / 443 / 479)
- memory ranking-score and messaging retry-delay (same family)
- scheduler execution-log durationMs (511)
- observability token-cost INSERT row (512)
- multi-agent orchestration-history summary (this goal)

Each fallback is tailored to the consumer's contract — here,
"filter the poison out of the aggregate while keeping the row
in the `runs` count" — but the underlying `Number.isFinite()`
guard reads identically across all sites.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry robustness
`fix:` on the multi-agent orchestration-history summary,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Filtered at the `summary()` consumer rather than rejecting at
  `record(entry)`: the store is the source of truth for what
  happened (good or bad); the consumer chooses whether to
  include corrupt entries in its math. This matches the goal-
  511 (scheduler) decision to defend at the aggregation
  boundary, not at the persistence boundary. Operators can
  still see the corrupt row via `list()` to investigate.
- Kept the `runs:` count of entries with each mode — including
  the poisoned-duration ones — because they still happened
  (the orchestrator did dispatch the workers, the run finished
  with some result). Hiding them from the count would
  silently mask the fact that a run completed; surfacing them
  in the count keeps the operator honest about cardinality
  while protecting the math.
- Refactored the three byMode reductions into one
  `byModeAvg(mode)` helper. Pre-fix the three blocks were 4
  lines each; the helper consolidates them and ensures the
  finite filter applies identically across the three modes
  without copy-paste drift.
- Guarded the divisor: when EVERY row is poisoned and
  `finiteDurations.length === 0`, `totalDuration / 0` is `NaN`
  (or `Infinity` for non-zero sum, which can't happen here).
  The new `sortedDurations.length === 0 ? 0 :` ternary returns
  0 — same convention as the existing empty-buffer early
  return at line 103.
- Step-8 redirect from the strict-parse run (513 / 514 / 515 /
  517) to the `??`-doesn't-catch-NaN defect class on a fresh
  surface (multi-agent orchestration history). Same class as
  goals 511 / 512 but on a different consumer, completing the
  triangle: scheduler logs, observability token rows, multi-
  agent orchestrations.
