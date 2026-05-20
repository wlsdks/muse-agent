# 527 — `InMemoryLatencyQuery.computeDurationMs` returns `undefined` on NaN instead of silently clamping to 0 (goal-526 sibling on the observability latency aggregation)

## Why

`packages/observability/src/observability-latency.ts:218` computed
each span's duration from the start/end Dates with no
finite-result guard:

```ts
function computeDurationMs(event: TraceEventInput): number | undefined {
  if (!event.endedAt) {
    return undefined;
  }
  const duration = event.endedAt.getTime() - event.startedAt.getTime();
  return duration >= 0 ? duration : 0;
}
```

The two consumers (`timeSeries` line 74, `summary` line 100)
correctly skip on `undefined` — but `computeDurationMs` never
returns `undefined` for an Invalid Date. The `!event.endedAt`
gate filters strictly missing endedAt; it doesn't filter
`new Date(NaN)`. If `event.startedAt` or `event.endedAt` is an
Invalid Date (corrupted DB row, clock-skew NaN, hand-edited
sidecar), `getTime() - getTime() = NaN`. Then:

- `NaN >= 0` is **false** (NaN comparisons all false)
- → the ternary returns the `: 0` branch
- → the corrupt span is silently recorded as a **0ms duration**

This inflates the fast-bucket count in `timeSeries`, drops the
real average in `summary`, and skews `p50/p95/p99` toward zero.
A single corrupted span doesn't crash the aggregation — it
silently mis-represents latency to the operator.

Same defect class as goal 526 (compat run-history
`latencyDistribution`), here on the observability traces side
of the same wire. The convention has landed on scheduler
execution-log (511), token-cost INSERT (512), multi-agent
summary (518), compat run-aggregations (526); the
observability latency aggregator's `computeDurationMs` was the
remaining outlier on the same defect class.

## Slice

- `packages/observability/src/observability-latency.ts` — added
  the `!Number.isFinite(duration)` branch between the
  subtraction and the negative-clamp:
  ```ts
  const duration = event.endedAt.getTime() - event.startedAt.getTime();
  if (!Number.isFinite(duration)) {
    return undefined;
  }
  return duration >= 0 ? duration : 0;
  ```
  Behaviour byte-identical for every clean finite duration
  (including the existing negative-clamp path for legitimate
  clock-skew); only the NaN/Infinity result of an Invalid-Date
  subtraction now returns `undefined`, hitting the consumer's
  existing `=== undefined` skip path.
- `packages/observability/test/observability.test.ts` — added
  one new `it(...)` block that records three spans (one clean
  +1000ms, one with `endedAt = new Date(NaN)`, one with
  `startedAt = new Date(NaN)`) and asserts the summary counts
  exactly 1 span (the clean one) with avgMs=1000. The two
  NaN-subtraction spans must NOT show up.

## Verify

- New test 1/1 green; full `@muse/observability` suite green
  (74 passed, +1 vs baseline 73, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `!Number.isFinite(duration)` guard makes the new test fail
  with the precise pre-fix symptom — `the two NaN-subtraction
  spans must NOT count toward the latency summary; they are
  corruption, not 0ms: expected 3 to be 1` (the 2 corrupt
  spans get counted as 0ms duration, inflating the count by
  3 and dragging avgMs from 1000 to ~333). Every other test
  stays green. Fix restored, suite back to 1 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure aggregation helper — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is
  `InMemoryLatencyQuery.timeSeries` and `.summary` →
  operator-facing latency rollups, not the model loop.

## Status

Done. A corrupted trace event with an Invalid-Date
`startedAt`/`endedAt` no longer silently counts as a 0ms span
in latency rollups. The cross-package finite-guard convention
now covers five sibling sites consistently:

- scheduler execution-log durationMs (511)
- observability token-cost INSERT row (512)
- multi-agent orchestration-history summary (518)
- compat run-history latency distribution (526)
- observability latency query `computeDurationMs` (this goal)

Each defends the consumer (aggregator/UI) from upstream
NaN/Infinity corruption with a single `Number.isFinite()`
check.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry
robustness `fix:` on the observability latency aggregator,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 526 — same defect class on
  the analogous observability traces aggregator, completing
  the pair. The convention now reads identically across the
  two latency aggregation paths (compat run-history +
  observability traces).
- Returned `undefined` (not 0) on NaN so the consumers'
  existing `=== undefined` skip path takes over: this
  separates "we don't know how long this took" from "this
  took 0ms". The operator's distribution doesn't get inflated
  by ghost-0ms entries. Mirrors goal 526's "unknown" bucket
  routing — same principle, different shape because this
  function returns `number | undefined` rather than feeding a
  bucket directly.
- Did NOT change the negative-clamp behaviour (`duration >= 0
  ? duration : 0`): a small negative duration is the real
  signal of clock-skew correction (NTP rewind during the
  span). Operators may legitimately want to see those as
  0ms spans. NaN is structurally different — it's not a
  small clock correction, it's a corrupt Date.
- The mutation reverts only the 3-line `if (!Number.isFinite
  ...)` guard rather than restoring the whole pre-fix shape:
  the test failure (`expected 3 to be 1`) reproduces the
  pre-fix observable byte-for-byte — three spans counted
  where only one is valid.
- Wrote the test through the `summary` consumer path rather
  than testing `computeDurationMs` in isolation: the
  function is internal (not exported), and the wire-level
  consequence (count=3 instead of 1, avgMs drift) is the
  operator-visible symptom worth pinning.
