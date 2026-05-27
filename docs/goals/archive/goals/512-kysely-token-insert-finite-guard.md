# 512 — `KyselyTokenUsageSink.record` consistently applies the existing `finiteTokens` / `finiteCostUsd` guards at the INSERT boundary (goal-428/436/437/443/479/511 sibling on the persisted token-usage row)

## Why

`packages/observability/src/observability-token-cost.ts` already
declares two helpers at the top of the file with the exact
threat model documented in their leading comment:

```ts
// `?? 0` does NOT catch NaN / Infinity. A single corrupt or
// badly-derived `estimatedCostUsd` (tokens × an undefined rate, a
// hand-edited "NaN" DB row) would otherwise poison the WHOLE
// daily / top-expensive / per-session aggregate it sums into AND
// the cost sort comparator (NaN ⇒ spec-undefined order).
function finiteCostUsd(value: number | undefined): number {…}
function finiteTokens(value: number | undefined): number {…}
```

The aggregation paths (lines 128–197 — `aggregateBySession`,
`aggregateDaily`, `topExpensiveSessions`) consistently use
these helpers on the way OUT. But the `KyselyTokenUsageSink.
record` INSERT path on the way IN was the **outlier**:

```ts
.values({
  completion_tokens: event.completionTokens,
  estimated_cost_usd: event.estimatedCostUsd === undefined
    ? "0" : String(event.estimatedCostUsd),
  …
  prompt_cached_tokens: event.promptCachedTokens ?? 0,
  prompt_tokens: event.promptTokens,
  reasoning_tokens: event.reasoningTokens ?? 0,
  total_tokens: event.totalTokens
})
```

Three concrete defects on this one insert:

1. **`promptCachedTokens ?? 0`** — `??` doesn't catch `NaN` /
   `±Infinity`. A poisoned usage object from a provider
   adapter (e.g. a fetch parser that produces `NaN` on a
   missing field) would write `NaN` to the
   `metric_token_usage.prompt_cached_tokens` column.
2. **`reasoningTokens ?? 0`** — same.
3. **`String(event.estimatedCostUsd)` on `NaN`** — yields the
   literal string `"NaN"` going into the
   `estimated_cost_usd` NUMERIC column. Depending on the DB
   driver, this either rejects the INSERT (losing the metric)
   or coerces silently. Either way, the daily / top-expensive
   aggregates that DO use `finiteCostUsd` defensively then
   have to filter the poison out — defence on the wrong side
   of the wire.

Same `??`-doesn't-catch-NaN defect class as goals 428 / 436 /
437 / 443 / 479 / 511. The asymmetry here is especially clear
because the file already contains the helpers and uses them
everywhere else — the INSERT path was a pure sibling-
asymmetry, not a missing primitive.

## Slice

- `packages/observability/src/observability-token-cost.ts` —
  extracted the INSERT value-building from
  `KyselyTokenUsageSink.record` into a pure exported helper
  `buildKyselyTokenInsertValues(event, now?)`. The helper
  pipes every numeric field through `finiteTokens` /
  `finiteCostUsd`. The class method now reads:
  ```ts
  await this.db
    .insertInto("metric_token_usage")
    .values(buildKyselyTokenInsertValues(event))
    .execute();
  ```
  Behaviour byte-identical for every clean numeric input —
  only NaN / ±Infinity inputs now clamp to 0 (matching the
  aggregation paths' existing convention).
- `packages/observability/test/build-kysely-token-insert-values.test.ts` —
  new file, 7 focused tests:
  - clean numbers pass through unchanged
  - optional fields default (step_type → "act", time →
    injected now, cached/reasoning tokens → 0,
    estimated_cost_usd → "0")
  - NaN `promptCachedTokens` → 0 (the defect this iteration
    closes — `?? 0` doesn't catch)
  - NaN `reasoningTokens` → 0
  - NaN `estimatedCostUsd` → "0" (not "NaN")
  - ±Infinity across all numeric fields → 0 / "0"
  - NaN on the required token fields (`promptTokens` /
    `completionTokens` / `totalTokens`) — tightens the
    contract to match the aggregation paths

## Verify

- New test 7/7 green; full `@muse/observability` suite green
  (73 passed, +7 vs baseline 66, 0 failed); tsc strict
  EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting just
  `prompt_cached_tokens: finiteTokens(…)` →
  `event.promptCachedTokens ?? 0` and the same for
  `reasoning_tokens` makes 3 tests fail with the precise
  pre-fix symptoms — `expected NaN to be +0`, `expected NaN
  to be +0`, `expected Infinity to be +0`. Every other test
  stays green. Fix restored, suite back to 7 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure value-builder — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the
  `metric_token_usage` DB row, not the model loop.

## Status

Done. A poisoned-NaN usage object from a provider adapter
(stuck on a missing `usage` field, malformed JSON, hand-
edited sidecar) no longer corrupts the `metric_token_usage`
DB row. The `??`-doesn't-catch-NaN convention now reads
identically on both sides of the wire for this file: the
INSERT path and the aggregation paths share one
`finiteTokens` / `finiteCostUsd` contract.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry
robustness `fix:` closing the INSERT-vs-aggregation
asymmetry, recorded honestly with this backlog row — not a
false metric.

## Decisions

- Extracted `buildKyselyTokenInsertValues` to a pure exported
  helper rather than testing through `KyselyTokenUsageSink.
  record` with a mocked Kysely chain: the value-building is
  the only thing the iteration touches; an end-to-end test
  would couple to Kysely's builder API plumbing that isn't
  the contract being pinned. Mirrors goals 502 / 503 / 510's
  extract-and-export decision.
- Threaded the `now: () => Date` injection through the helper
  so tests can pin the `time` field deterministically. The
  class method calls the helper with the default
  `() => new Date()`, so production behaviour is byte-
  identical.
- Tightened `promptTokens` / `completionTokens` / `totalTokens`
  to also go through `finiteTokens` (they were unguarded
  pre-fix on the INSERT path even though they're required-
  number in the type). The aggregation paths (lines 128–197)
  already do this; the INSERT path matching that convention
  closes the asymmetry completely. Behaviour byte-identical
  for any valid record.
- Step-8 redirect from the scheduler durationMs run (511) to
  the observability token-insert path. Same defect class,
  distinct surface (metric_token_usage vs scheduler
  execution-log) — productive sibling pivot, not same-area
  churn.
- Did NOT change the existing `finiteTokens` / `finiteCostUsd`
  helper bodies (they're correct). The fix is purely about
  CALLING them at the third site in the same file.
