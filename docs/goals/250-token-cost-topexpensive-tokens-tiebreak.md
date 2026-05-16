# 250 — `topExpensive` was an arbitrary all-ties order for free local LLMs

## Why

`TokenCostQuery.topExpensive` ranks runs by spend so the user can
see "which runs cost the most". Both implementations sorted by
`totalCostUsd DESC` and nothing else:

- `InMemoryTokenCostQuery`:
  `.sort((a, b) => b.totalCostUsd - a.totalCostUsd)`
- `KyselyTokenCostQuery`: `ORDER BY total_cost_usd DESC`

Muse's hard constraint here is Qwen-only via local Ollama —
**every run's `estimatedCostUsd` is 0**. So for the actual
default operating mode the comparator is `0 - 0` for every pair:
the ranking collapses to an all-ties order. `Array.prototype.sort`
on all-equal keys is not a stable, meaningful ordering, so
`muse` token-cost "top expensive" returned an effectively random
list of runs — a dead, non-deterministic feature precisely in the
zero-cost local-LLM scenario that is the project's primary target.

## Scope

Add a secondary sort key — `totalTokens DESC` — to both
implementations of `topExpensive`:

- `packages/observability/src/observability-token-cost.ts`
  - In-memory:
    `b.totalCostUsd - a.totalCostUsd || b.totalTokens - a.totalTokens`
  - Kysely: `ORDER BY total_cost_usd DESC, total_tokens DESC`

When dollar cost is free (or simply tied), the ranking falls back
to token volume — the meaningful proxy for "most expensive" on a
local model — and is now deterministic. Behaviour for paid
providers with distinct costs is unchanged (the secondary key
never triggers when the primary differs). `daily` is left as-is:
it is a per-day/model aggregation table, not a "top" ranking, so
the all-ties degradation does not apply the same way; keeping the
change to the one ranking query holds scope tight.

## Verify

- `pnpm --filter @muse/observability test` — 55 pass (was 54;
  +1). New test records three runs all at `estimatedCostUsd: 0`
  with `totalTokens` 120 / 9000 / 3000 and asserts
  `topExpensive` returns `["huge", "mid", "small"]` (token-volume
  DESC). The existing "descending by cost" test (distinct costs)
  still passes — the secondary key does not perturb a real
  cost ranking.
- `pnpm check` — every workspace green (observability 55,
  apps/cli 555, apps/api 155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure telemetry query
  ordering — in-memory comparator + a SQL `ORDER BY` extension),
  so no Qwen round-trip applies. The Kysely change mirrors the
  in-memory semantics exactly; the in-memory path (the local /
  no-DB mode the loop runs in) is the one covered by the
  deterministic unit test.

## Status

done — `topExpensive` now ranks cost-tied runs by token volume, so
the "most expensive runs" view is useful and deterministic under
the Qwen-only, zero-cost local-LLM mode instead of an arbitrary
all-ties order. Paid-provider rankings with real distinct costs
are unaffected.
