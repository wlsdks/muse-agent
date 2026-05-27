# 676 — `SupervisorAgent.selectWorker` breaks a confidence tie by worker id (ASC) so multi-agent dispatch is deterministic across runs — two equally-confident workers no longer route to whichever one happened to be earlier in the `workers[]` array

## Why

`packages/multi-agent/src/index.ts:SupervisorAgent.selectWorker`
ranked candidate workers by confidence and picked the top:

```ts
const ranked = this.workers
  .filter((worker) => !excludedIds.has(worker.id))
  .map((worker) => ({ confidence: clamp(worker.canHandle(input), 0, 1), worker }))
  .sort((left, right) => right.confidence - left.confidence);   // ← no tiebreaker
const best = ranked[0];
```

When two workers return the **same** confidence, the comparator
returns `0` and V8's TimSort preserves their relative input
order. So `ranked[0]` — and thus the dispatched worker — depends
on the order the workers were passed to the `SupervisorAgent`
constructor. The same input can route to a different worker if
the `workers[]` array is reordered (config change, a registry
that enumerates in a different order, a set→array conversion).

This is reachable in practice: `RuleBasedAgentWorker.canHandle`
returns a keyword-match ratio, so two workers sharing a keyword
(`["task"]` vs `["task", "code"]` both matching "task", or two
workers with identical keyword sets) tie on confidence. With
`minConfidence` default 0.1, both clear the bar and the
dispatch is a coin flip on array order. For a system that's
supposed to route the same request to the same specialist every
time, that's a silent nondeterminism — and it makes any test
asserting "request X goes to worker Y" flaky.

The fix adds a stable secondary key: `|| left.worker.id.localeCompare(right.worker.id)`,
so a tie resolves to the lexicographically-smallest worker id,
deterministically and independent of array order.

### Defect class

**Sort comparator non-deterministic on a full tie** — same
class as goals 634 (run-history) and 658 (personal-store
comparators), but a distinct site (multi-agent dispatch) and a
fresh AREA (the `multi-agent` package, untouched in the recent
window). 658 was ~18 iters ago — 0 of the last 10 iters in
this class.

Recent 10-iter window:

- 675: vision data-URL base64 validation
- 674: strict ?limit= parse (api history)
- 673: Math.min/max spread RangeError (calendar)
- 672: HTTP timeout (LINE)
- 671: asymmetric validation (web-search)
- 670: calendar local-timezone render
- 669/668: HTTP timeout (messaging)
- 667/666: route to synthesizeAndPlay

Deliberately a different area than the recent calendar /
messaging / api-routes / vision runs.

## Slice

- `packages/multi-agent/src/index.ts`:
  - One-token addition to the `selectWorker` sort:
    `right.confidence - left.confidence || left.worker.id.localeCompare(right.worker.id)`.
- `packages/multi-agent/test/multi-agent.test.ts`:
  - **One new test**: two workers (`zebra`, `alpha`) with the
    same keyword `["task"]` (→ identical confidence on input
    "task"). Asserts `selectWorker(...).to === "alpha"` (id ASC)
    for BOTH `[zebra, alpha]` and `[alpha, zebra]` orderings —
    the determinism guarantee.

## Verify

- `pnpm --filter @muse/multi-agent test`: 52 passed (51 prior +
  1 new). Full `pnpm check`: every workspace green; tsc strict
  EXIT=0.
- **Clean-mutation-proven**: reverting the tiebreaker to the
  bare `right.confidence - left.confidence` makes the new test
  fail — the `[zebra, alpha]` ordering routes to "zebra"
  (TimSort preserves input order on a tie) instead of the
  expected "alpha". The pre-existing SupervisorAgent tests
  (highest-confidence routing, fallback-after-failure,
  requires-a-worker) pass either way. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched — `selectWorker` is
  a pure routing decision over `worker.canHandle` scores; the
  test uses `RuleBasedAgentWorker` (no model call). `smoke:live`
  doesn't apply.

## Status

Done. Multi-agent dispatch is deterministic on ties:

| Two workers, equal confidence | `workers: [zebra, alpha]` | `workers: [alpha, zebra]` |
| ----------------------------- | ------------------------- | ------------------------- |
| Pre-fix                       | → zebra                   | → alpha                   |
| Post-fix                      | → **alpha**               | → **alpha**               |

The dispatched worker now depends only on the workers' ids and
confidences, not on the order they were registered.

## Decisions

- **`localeCompare` ASC on worker id** — matches the
  convention goals 634 / 658 set (createdAt-or-instant
  primary, id ASC tiebreaker). Worker ids are
  developer-assigned stable strings, so ASC is a meaningful,
  stable order (not arbitrary like a UUID, though it'd be
  deterministic either way).
- **Tiebreak in `selectWorker` only** — that's the single
  dispatch chokepoint. The `MultiAgentOrchestrator` fan-out
  (`Promise.all(workers.map(...))`) doesn't rank by confidence
  (it runs all workers), so it has no tie to break.
- **Did NOT change `minConfidence` or the fallback logic** —
  the bug was purely the missing secondary sort key. The
  fallback path (`best?.confidence ?? 0`) already handles the
  no-eligible-worker case deterministically.
- **Mutation choice** — reverted the tiebreaker. The
  `[zebra, alpha]` ordering routes to "zebra", failing the
  determinism assertion; the existing routing / fallback tests
  pass. Surgical proof.

## Remaining risks

- **`worker.canHandle` returning NaN** would make the
  confidence comparison `right - left` produce NaN (TimSort
  treats NaN comparisons as 0 → input order). `clamp(x, 0, 1)`
  is applied to the confidence — but `clamp(NaN, 0, 1)`
  returns NaN (Math.max/min with NaN → NaN). A misbehaving
  worker returning NaN would still produce a degenerate sort.
  The `RuleBasedAgentWorker` returns a finite ratio, so this
  isn't reachable today; a `Number.isFinite` guard in `clamp`
  or at the map step would harden it. Sibling-fixable;
  out of scope (no observed NaN-returning worker).
- **Equal id is impossible** in practice — `SupervisorAgent`
  doesn't dedupe worker ids, but two workers with the same id
  is an upstream config error; the tiebreaker would return 0
  and fall back to input order for that pathological case.
- **The orchestrator's per-worker fan-out order** is the
  `workers[]` array order (it runs all sequentially /
  parallel); that's intentional and unaffected — only the
  supervisor's single-pick routing needed determinism.
