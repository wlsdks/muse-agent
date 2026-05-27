# 745 — fix: KyselyTokenCostQuery daily/topExpensive deterministic tiebreak (parity with InMemory)

## Why

`InMemoryTokenCostQuery` documents + unit-tests a final ordering
tiebreak so same-day/same-cost rows don't shuffle across reloads:
`daily` breaks cost ties by `model` ASC, `topExpensive` breaks
cost+token ties by `runId` ASC. The comment there is explicit: under
the Qwen-only / $0-cost mandate EVERY row ties on cost, so without the
tiebreak the ordering is "arbitrary all-ties order."

The production `KyselyTokenCostQuery` SQL lacked those final
tiebreaks:

- `daily`: `ORDER BY day DESC, total_cost_usd DESC`
- `topExpensive`: `ORDER BY total_cost_usd DESC, total_tokens DESC`

So `muse cost daily` / `muse cost top` against Postgres returned
same-day/same-cost rows in Postgres's arbitrary aggregate order —
shuffling between reloads — while the in-memory path (tests, no-DB
setups) was stable. A behavioral divergence between the two
implementations of the same `TokenCostQuery` interface.

## Slice

- `daily`: `ORDER BY day DESC, total_cost_usd DESC, model ASC`.
- `topExpensive`: `ORDER BY total_cost_usd DESC, total_tokens DESC, run_id ASC`.

Now both query backends agree on the documented deterministic order.

## Verify

- New gated Postgres integration test (`token-cost-postgres.test.ts`,
  `describe.skipIf(MUSE_DB_POSTGRES_TEST !== "1")` — mirrors
  `@muse/db`'s postgres-runtime test, so default `pnpm check` skips it
  and stays Docker-free). Spins up `postgres:16-alpine` via
  testcontainers, applies `@muse/db` migrations, inserts same-day
  same-cost (`$0`) rows in REVERSE of the sorted order, and asserts
  `daily` → `model` ASC and `topExpensive` → `runId` ASC. Ran locally
  with `MUSE_DB_POSTGRES_TEST=1` (Docker) — both pass, consistently.
- `pnpm check`: EXIT=0 (gated test skips). `pnpm lint`: 0/0 (standalone).
  testcontainers + pg added as devDeps (already in the monorepo
  lockfile via `@muse/db` — no new external/paid dep).

## Decisions

- **Correct-by-construction, not a strict mutation-proof** — a SQL
  `ORDER BY … ASC` tiebreak is declaratively deterministic, and the
  fix mirrors the InMemory version's already-unit-tested+documented
  tiebreak. The integration test verifies the fixed query is valid SQL
  and returns sorted order against real Postgres, but it canNOT be a
  reliable mutation-proof: the *unfixed* query's tie order is
  Postgres-arbitrary and sometimes coincidentally sorted (observed) —
  that non-determinism IS the bug, and a deterministic test can't
  reproduce it on demand. The fix's correctness rests on the
  declarative ORDER BY + InMemory parity.
- **Gated test, not added to the default gate** — Docker-dependent
  tests stay opt-in (`MUSE_DB_POSTGRES_TEST=1`) exactly like the
  existing `@muse/db` postgres test, so CI/`pnpm check` is unaffected.
