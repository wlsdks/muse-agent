# 579 — `InMemoryTokenCostQuery.daily` adds model asc tertiary tiebreaker (goal-556/578 deferred sibling — sweep finally closed)

## Why

Direct goal-556/578 follow-up. Goal 556 (`topExpensive`)
added an `a.runId.localeCompare(b.runId)` tertiary tiebreaker
for cost-AND-token-tied runs, and noted two still-deferred
comparator-determinism sites: `aggregateDailyByModel` (in
`observability-token-cost.ts:183`) and `guard-monitor.ts:114`.
Goal 578 closed the guard-monitor one. This iteration closes
the last remaining outlier from that defer list.

Pre-fix `daily` comparator:

```ts
return [...groups.values()].sort((a, b) => {
  if (a.day === b.day) {
    return b.totalCostUsd - a.totalCostUsd;
  }
  return a.day < b.day ? 1 : -1;
});
```

When `a.day === b.day` AND `a.totalCostUsd === b.totalCostUsd`,
the comparator returns 0 and `[...groups.values()]` order
inherits `Map` insertion order — which is event-arrival order
(the first event for each `<day>|<model>` key creates the
bucket). On a Qwen-only / local-LLM setup, EVERY entry has
cost 0 (the existing comment on `topExpensive` calls this
out specifically), so every same-day row pair is tied on
cost. The dashboard then renders same-day model rows in
arrival order — which changes between reloads as new
events shift the underlying Map.

Real-world impact: `muse cost daily` (which routes through
this query) shows same-day model rows shuffling across
consecutive invocations on a Qwen-only install — the exact
HARD CONSTRAINT setup the project enforces. The id
tertiary tiebreaker (`model` here) restores determinism.

## Slice

- `packages/observability/src/observability-token-cost.ts`
  — extended the same-day branch with the model asc
  tiebreaker:
  ```ts
  if (a.day === b.day) {
    return b.totalCostUsd - a.totalCostUsd || a.model.localeCompare(b.model);
  }
  ```
  Single-line change; no behavioural drift for rows with
  distinct day or distinct cost. Added a 4-line WHY
  comment naming the Qwen-only trip-wire (matches the
  `topExpensive` comment style from goal 556).
- `packages/observability/test/observability.test.ts` —
  added one focused `it(...)` immediately after the
  existing daily-roll-up test: three same-day events
  all at `estimatedCostUsd: 0`, recorded in
  `qwen-b → qwen-a → qwen-c` order. The daily output
  must come back as `[qwen-a, qwen-b, qwen-c]`
  regardless of arrival.

## Verify

- New `it(...)` green; full `@muse/observability` suite
  green (76 passed, +1 vs baseline 75, 0 failed); tsc
  strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `|| a.model.localeCompare(b.model)` token to the bare
  `return b.totalCostUsd - a.totalCostUsd;` shape makes
  the new test fail with `expected [ 'qwen-b', 'qwen-a',
  'qwen-c' ] to deeply equal [ 'qwen-a', 'qwen-b',
  'qwen-c' ]` — the event-arrival order leaks verbatim.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api
  249 passed, apps/cli 1030 passed, packages/observability
  76 passed); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the three
  intended files.
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is
  `muse cost daily` output, not the model loop.

## Status

Done. Both `topExpensive` (556) and `daily` (579) now share
the same convention: same-key ties resolve by stable id
ascending (`runId` and `model` respectively). The
goal-556 deferred list is fully closed:

| Site | Goal closed in |
| --- | --- |
| `topExpensive` cost+tokens tie | 556 (runId asc) |
| `guard-monitor.ts:114` blockRate+blocked tie | 578 (guardId asc) |
| `aggregateDailyByModel` day+cost tie | **579 (this — model asc)** |

A future grep on `observability-token-cost.ts` for
`.sort((a, b) =>` should return only comparators with
a tertiary tiebreaker on the relevant id field.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a
sibling-asymmetry comparator-determinism `fix:` on the
token-cost daily roll-up, recorded honestly with this
backlog row — not a false metric.

## Decisions

- `model` as the tiebreaker. Reason: the `Map` is keyed
  by `<day>|<model>`, so within a same-day partition the
  model name is the natural unique stable id. Considered
  also tiebreaking by `totalTokens` — rejected because
  identical prompt templates can produce identical token
  counts, so it doesn't strictly tiebreak; model is
  guaranteed unique within `<day>|*`.
- Direction matches goal 556: desc primary (cost — most
  expensive first within the day), asc id tertiary
  (alphabetical model within ties). Reader expectation:
  "most expensive first per day; within ties,
  alphabetical".
- Did NOT touch the cross-day branch
  (`a.day < b.day ? 1 : -1`). That's already
  deterministic — days are unique strings.
- Mutation reverts to the pre-fix bare cost comparator
  (one of the two same-day branches). Smallest delta;
  surgical proof.
- The 4-line WHY comment names the Qwen-only HARD
  CONSTRAINT explicitly. Comment policy allows this —
  the WHY is non-derivable from the code (the
  trip-wire requires knowing that every cost==0 on a
  Qwen-only setup, which the surrounding code doesn't
  capture).
- The test asserts a 3-row fixture (not 2) so the
  tiebreaker effect is unmistakable. The pre-fix
  output `[qwen-b, qwen-a, qwen-c]` mirrors the
  insertion order verbatim, clearly distinct from the
  asserted `[qwen-a, qwen-b, qwen-c]` sorted output.
- Step-8 sub-defect-class check: comparator-determinism
  was just shipped in 578 (one iteration ago). But the
  goal-556 deferred list explicitly names this as the
  next slot, and these are both deferred-sibling
  closures — the "convention sweep complete" arc is
  the load-bearing logic. Same pattern goal 558 closed
  goal 557's deferred sibling immediately after.
