# 556 — `topExpensive` ranks cost-AND-token-tied runs by runId asc (observability-side sibling of the comparator-determinism sweep)

## Why

Step-8 redirect from the run of CLI/messaging-area iterations
(551-555) onto a fresh package — `packages/observability` —
with the same defect class. The `topExpensive` query already
has the cost-tie → token-volume fallback (`b.totalCostUsd -
a.totalCostUsd || b.totalTokens - a.totalTokens`); the
existing inline comment specifically calls out the Qwen-only
local-LLM scenario where `estimatedCostUsd === 0` for every
run, making token volume the meaningful proxy. What it lacks
is the final tiebreaker for the case both keys ALSO tie.

That case is realistic on a Qwen-only Muse install:

- The user runs the same daily-brief / weekly-review template
  twice (`muse brief`, `muse today`)
- The model is fixed (qwen3:8b), the prompt template is
  deterministic, the input data is similar enough that
  `totalTokens` lands identically across the two runs
- `estimatedCostUsd === 0` for both
- Cost-tied AND token-tied → comparator returns 0 → stable
  sort yields to insertion order from `groups.values()`

The user's `muse cost top` output for those two runs could
flip between reload cycles. For the Qwen-only HARD CONSTRAINT
this is exactly the loud-blind-spot where the cost ranking
loses determinism most often.

`runId` is the natural stable tertiary key. It's already
echoed in the output object (`TokenCostTopExpensiveEntry`),
and `groups.values()` keys by `runId` so the value is always
present. Same convention as goals 530/531/533/537/546/551/555.

## Slice

- `packages/observability/src/observability-token-cost.ts` —
  added the asc-by-runId tertiary tiebreaker on the
  `topExpensive` comparator:
  ```ts
  .sort((a, b) =>
    b.totalCostUsd - a.totalCostUsd ||
    b.totalTokens - a.totalTokens ||
    a.runId.localeCompare(b.runId)
  )
  ```
  Replaces the two-tier `cost || tokens` comparator.
  The inline comment extended to explain why the runId
  tiebreaker matters: same-prompt-template re-fires under a
  Qwen-only setup tie on BOTH cost and tokens.
- `packages/observability/test/observability.test.ts` —
  added one focused `it(...)`: three runs at
  `estimatedCostUsd=0, totalTokens=1000`, inserted as
  `["run-b", "run-a", "run-c"]`, must come back as
  `["run-a", "run-b", "run-c"]` through `topExpensive(...)`.

Direction matches the surrounding 533/537/551/555 convention:
desc primary keys (most expensive / largest first), asc id
tertiary tiebreaker.

## Verify

- New `it(...)` green; full `@muse/observability` suite green
  (75 passed, +1 vs baseline 74, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `|| a.runId.localeCompare(b.runId)` token to the bare
  `b.totalCostUsd - a.totalCostUsd || b.totalTokens -
  a.totalTokens` comparator makes the new test fail with
  the precise pre-fix symptom — `runs tied on both cost
  and tokens must come back in runId asc: expected
  [ 'run-b', 'run-a', 'run-c' ] to deeply equal [ 'run-a',
  'run-b', 'run-c' ]`. Fix restored, suite back to all
  green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git
  status` shows only the three intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is `muse cost
  top` output, not the model loop.

## Status

Done. The id-tiebreaker convention now reads identically
across:

- API server-side: `/api/today` reminders/followups/tasks
  (533)
- CLI local-mode renders: `muse followup list`, `muse today
  --local` (537), `muse remind list --local` (551)
- Other persistence-render paths: `vacuumEpisodes` (519),
  `queryActionLog` (530), `suggestPatternHints` (531),
  `compareFeedEntriesNewestFirst` (546)
- Messaging inbox surface: `filterFresh` (555)
- **Observability token-cost: `topExpensive` (this goal)**

No CAPABILITIES line / no OUTWARD-TARGETS flip: all
P-bullets are already `[x]` and audited; a sibling-asymmetry
comparator-determinism `fix:` on the token-cost top-N
ranking, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Step-8 redirect onto a fresh package (observability) and
  a fresh surface (`muse cost top` reporting). Different
  blast radius from the CLI/messaging cluster, same defect
  class — productive sibling sweep.
- `runId` is the obvious tertiary key: stable, unique, already
  echoed in the output. `model` would be a weaker
  tiebreaker (two runs of the same template tie on it too);
  `time` would non-deterministically order based on
  recording precision. runId is strictly correct.
- Direction stays desc primary + desc secondary + asc id.
  Reader expectation: "show me the most expensive first";
  within ties, alphabetical id is the surrounding-package
  convention.
- Did NOT touch the `aggregateDailyByModel` sort on line
  183 (`b.totalCostUsd - a.totalCostUsd` within same day —
  two same-day same-cost rows tie). That's a fresh sibling
  iteration target if the defect class comes up again;
  one-iteration-per-area scope keeps the diff reviewable.
- Did NOT touch the `guard-monitor.ts:114` sort
  (`right.blockRate - left.blockRate || right.blocked -
  left.blocked`) — another fresh iteration target, separate
  surface (admin/security dashboard).
