# 578 — `GuardBlockRateMonitor.byGuard` adds guardId asc tertiary tiebreaker (goal-556 deferred sibling)

## Why

Direct sibling of the comparator-determinism sweep that's
been running across the codebase (goals 519/530/531/533/537/
546/551/555/556/574). Goal 556's Decisions block explicitly
deferred two sites: `aggregateDailyByModel` (observability)
and `guard-monitor.ts:114`. This iteration closes the
guard-monitor outlier.

Pre-fix:

```ts
.sort((left, right) => right.blockRate - left.blockRate || right.blocked - left.blocked);
```

Two-key sort. When BOTH keys tie — e.g. two fresh guards
each with `blockRate=0, blocked=0` (the canonical "fresh
production setup" state, before any blocked event) — the
comparator returns 0. `[...buckets.entries()]` ordering
inherits `Map` insertion order, which is the order events
recorded each guard for the first time. The first event for
any guard depends on traffic arrival, not configuration —
so two consecutive snapshots can render the same fresh set
in different orders.

Real impact: the snapshot drives `/api/admin/monitors/
guard-block-rate`'s output. Operators inspecting the
dashboard see guard rows shuffle between refreshes when no
events have fired against them yet. The alerting threshold
isn't affected (it operates on the aggregate `blockRate`,
not row order) but the dashboard's perceived stability is.

`guardId` is the natural tertiary key — already emitted in
the output, always unique within `byGuard` (the underlying
`Map` keys by guardId).

## Slice

- `packages/policy/src/guard-monitor.ts:114` — added the
  asc-by-guardId tertiary tiebreaker:
  ```ts
  .sort((left, right) =>
    right.blockRate - left.blockRate ||
    right.blocked - left.blocked ||
    left.guardId.localeCompare(right.guardId)
  );
  ```
  Single-line addition; no behavioural drift for rows
  with distinct `blockRate` or `blocked`.
- `packages/policy/test/guard-monitor.test.ts` — added
  one focused `it(...)` between the existing
  "tracks block rates" test and the canary describe:
  three guards each see one allowed event (`blockRate=0,
  blocked=0` for all), recorded in
  `Beta → Alpha → Charlie` insertion order. `byGuard`
  must return `[Alpha, Beta, Charlie]` regardless of
  arrival order.

## Verify

- New `it(...)` green; full `@muse/policy` suite green
  (68 passed, +1 vs baseline 67, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `|| left.guardId.localeCompare(right.guardId)` token
  to the bare two-key comparator makes the new test fail
  with the precise pre-fix symptom — `expected
  [ 'BetaGuard', 'AlphaGuard', 'CharlieGuard' ] to deeply
  equal [ 'AlphaGuard', 'BetaGuard', 'CharlieGuard' ]`.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api
  249 passed, apps/cli 1030 passed, packages/policy 68
  passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is the
  `GuardBlockRateMonitor.snapshot().byGuard` admin
  dashboard surface, not the model loop.

## Status

Done. The id-tiebreaker convention now reaches the policy
guard-monitor surface, completing the comparator-
determinism sweep on the path goal 556 explicitly named
as deferred. The other deferred site
(`aggregateDailyByModel` in observability-token-cost.ts)
remains a fresh iteration target.

A future grep for `.sort((left, right) => ...)` without a
final `|| ...localeCompare(...id)` or equivalent should
return only:
- pure-numeric arrays (e.g., median/percentile sorts on
  durations) where there's no id concept
- single-key sorts that have already been guaranteed
  unique by the producer

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
sibling-asymmetry comparator-determinism `fix:` on the
guard-monitor admin surface, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Direction matches the surrounding convention: desc
  primary (blockRate — highest-block-rate first), desc
  secondary (blocked — most-blocked-count first), asc
  id tertiary (alphabetical within ties). Reader
  expectation: "show me the most-problematic guards
  first; within ties, alphabetical".
- `guardId` (not `total`) as the tertiary key. `total`
  could be a fourth-key candidate but guardId is unique
  and stable across snapshots; `total` would tie for
  fresh guards too. Single source of stability.
- Did NOT switch the existing `right.* - left.*`
  descending convention to ascending. Inverting one key
  would be cosmetic; the existing pattern works.
- Mutation reverts the precise delta (the
  `|| left.guardId.localeCompare(right.guardId)` token).
  Smallest semantic delta; surgical proof.
- The test asserts a 3-guard fixture (not 2) so the
  tiebreaker effect is unmistakable — with 2 guards,
  any insertion order matches at least one of the
  two possible outputs by coincidence. With 3 guards,
  the pre-fix `[Beta, Alpha, Charlie]` insertion-order
  output is clearly distinct from the asserted
  `[Alpha, Beta, Charlie]` sorted output.
- Step-8 sub-defect-class check: comparator-determinism
  was last shipped 4 iterations ago (574 — calendar
  listEvents). Well within the ≥3-in-last-10 threshold
  (only 1 in the last 10); the explicit defer in goal
  556 also names this as the right next slot. Fresh
  defect-class slot.
