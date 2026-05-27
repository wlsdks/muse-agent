# 428 — A non-finite token cost can't poison the cost aggregate

## Why

Robustness fix on a fresh axis (`@muse/observability`
`observability-token-cost.ts` — backs `muse cost`, the admin
observability snapshot, and the SLO/drift/budget feed; never
touched by the recent autoconfigure/agent-core/cli cluster).

Every cost-read point summed `event.estimatedCostUsd ?? 0`. `??`
catches only `null`/`undefined`, **not `NaN`/`Infinity`**. A
single corrupt or badly-derived cost (tokens × an undefined
price rate → `NaN`; a hand-edited / migrated `estimated_cost_usd`
text row read back via `Number("NaN")`) therefore poisons:

- the whole `day|model` `daily()` group total (→ `NaN`), and the
  `daily` sort comparator (`b.totalCostUsd - a.totalCostUsd` with
  `NaN` ⇒ ECMAScript-undefined sort order — the whole list
  reorders arbitrarily);
- the same in `topExpensive()` (one bad run corrupts its
  `totalCostUsd` and the `b.cost - a.cost || b.tokens - a.tokens`
  comparator);
- `bySession()` per-step `estimatedCostUsd`.

This is the exact `??`-doesn't-catch-`NaN` class the codebase
already documents and fixes elsewhere (scheduler
`resolveJobTimeout`, goal 414 `parseInteger`, goal 418 episode
summariser) — so the guard here is consistent, non-speculative
hardening of a user-facing aggregate, not new behaviour.

## Slice

- `packages/observability/src/observability-token-cost.ts` — add
  `finiteCostUsd(value) = Number.isFinite(value) ? value : 0` and
  apply it at all five cost reads: `bySession` (in-memory),
  `daily`, both `topExpensive` branches, and the
  `KyselyTokenCostQuery.bySession` `Number(row.estimated_cost_usd)`
  mapping. A non-finite cost now contributes `0` instead of
  poisoning the sum and the sort.
- `packages/observability/test/observability.test.ts` —
  regression in the existing `InMemoryTokenCostQuery` describe: a
  `NaN`-cost event among finite ones → `daily` total is the
  finite sum (not `NaN`), the bad run's `topExpensive` cost is
  `0`, the ranking is well-defined, and `bySession` reports `0`.
  Fails on the pre-fix code (`daily` total was `NaN`).

## Verify

- `@muse/observability` NaN-cost regression passes; full suite
  green (61, +1); existing happy-path daily/top/bySession tests
  unchanged (the guard is identity for finite values — no
  regression); tsc strict clean.
- `pnpm check` EXIT=0, every workspace green (observability 61,
  api 194, cli 731, …); `pnpm lint` 0/0; `pnpm guard:core`
  clean; byte-scan clean.
- Pure deterministic aggregation verified with fixtures; not a
  model request/response path — no `smoke:live` applies.

## Status

Done. One corrupt/derived non-finite cost row can no longer turn
the `muse cost` daily breakdown / top-expensive ranking into
`NaN` (and scramble its order) — the bad row contributes `0` and
every other row's figure stays accurate.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a robustness fix to an existing aggregate,
recorded honestly as a `fix(observability):` change with this
backlog row — not a false metric.

## Decisions

- Scoped to `estimatedCostUsd`: it is the headline number, the
  most derived (hence NaN-prone) field, and the one feeding the
  sort comparators that `NaN` corrupts most visibly — the exact
  observed footgun. Token counts are provider-reported integers;
  a blanket token-finite sweep would be speculative scope-creep
  beyond the observed failure.
- Kysely `daily`/`topExpensive` use SQL-side aggregation (a
  different mechanism, not a JS `??`-NaN bug) and are left
  untouched — guarding them would need SQL-level handling and is
  out of this goal's scope.
