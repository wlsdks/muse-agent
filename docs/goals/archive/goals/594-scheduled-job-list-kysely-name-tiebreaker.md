# 594 — `KyselyScheduledJobStore.list` adds an `ORDER BY name ASC` tiebreaker to match the in-memory `compareJobs` two-key sort (createdAt ASC, name ASC)

## Why

`packages/scheduler/src/scheduler-stores.ts` ships two
implementations of `ScheduledJobStore.list()`:

- **InMemory** — `[...this.jobs.values()].sort(compareJobs)`.
  `compareJobs` (in `scheduler-helpers.ts`):

      return left.createdAt.getTime() - right.createdAt.getTime()
        || left.name.localeCompare(right.name);

  Two-key sort. Same-timestamp ties fall to name ASC.

- **Kysely (pre-fix)** —
  `db.selectFrom("scheduled_jobs").selectAll()
   .orderBy("created_at", "asc")`.

  One-key sort. Same-timestamp ties come back in DB-natural-order
  (engine-dependent, undefined across PostgreSQL versions and
  query plans).

Two jobs created in the same millisecond — easy under a bulk
seed, a test fixture, or a Date.now() collision — return in
deterministic alphabetical order from the in-memory store and
in arbitrary order from the Kysely store. Any test that drives
the in-memory store and asserts a specific ordering passes
silently against in-memory and breaks when wired against Kysely.

This is the same in-memory/Kysely parity defect family as
goal 593 (`debug-replay` list order direction), but on a
different file and a different sort axis (createdAt ASC primary,
name ASC tiebreaker — vs goal 593's capturedAt DESC).

Step-8 redirect: in `packages/scheduler` (last touched in goals
562/563 for finite-guards on validateExecutionTimeout /
validateRetryConfig). Distinct defect class from the prior
commits' env-flag spelling, SSRF, NaN-poisoning, and
order-direction parity — this one is "Kysely lacks the
tiebreaker that the in-memory comparator has."

## Slice

- `packages/scheduler/src/scheduler-stores.ts`:
  - Extracted the list query into a new exported helper
    `buildScheduledJobListQuery(db)` that builds the SELECT
    with BOTH `orderBy("created_at", "asc")` and
    `orderBy("name", "asc")`. The class method
    `KyselyScheduledJobStore.list()` now calls the helper.
  - Helper is exported so a unit test can introspect the
    compiled SQL via Kysely's `DummyDriver` + `.compile()`
    without lifting a real Postgres — same pattern
    `packages/runtime-state/test/kysely-stores.test.ts` uses
    for `buildCheckpointUpsertQuery`.
- `packages/scheduler/src/index.ts` — re-exported
  `buildScheduledJobListQuery` from the barrel.
- `packages/scheduler/test/scheduler.test.ts`:
  - Imported the Kysely `DummyDriver` / `PostgresAdapter` /
    `PostgresIntrospector` / `PostgresQueryCompiler` runtime
    values alongside the existing `Kysely` type import.
  - Added one test in the existing "Kysely mapping helpers"
    describe: constructs a `DummyDriver`-backed `Kysely`,
    calls `buildScheduledJobListQuery(db).compile()`, and
    asserts the SQL string matches the regex
    `/order by "created_at" asc,\s*"name" asc/iu`. Also
    asserts the FROM clause hits the `scheduled_jobs` table
    as a sanity check on the query shape.

## Verify

- `@muse/scheduler` suite green (85 passed, +1 vs baseline 84,
  0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): removing the
  `.orderBy("name", "asc")` chain in
  `buildScheduledJobListQuery` makes the new test fail with
  the regex `/order by "created_at" asc,\s*"name" asc/iu`
  not matching the compiled SQL (which only has the
  `created_at` clause). 1-of-1 mutation-down. Fix restored.
- `pnpm check` EXIT=0 (apps/api 254 passed, apps/cli 1040
  passed, every workspace green); `pnpm lint` 0/0; `pnpm
  guard:core` clean; `git status` shows only the three
  intended files.
- No LLM request-response wire path touched; `smoke:live` does
  not apply (per `testing.md` / iteration-loop Step 9). The
  defended path is `KyselyScheduledJobStore.list` —
  exercised by `/api/scheduler/jobs` reads and the scheduler
  daemon's tick — not the model loop.

## Status

Done. The in-memory and Kysely scheduled-job stores now agree
on list ordering:

| Scenario                                         | Before (in-memory)        | Before (Kysely)         | After (both)              |
| ------------------------------------------------ | ------------------------- | ----------------------- | ------------------------- |
| Two jobs at different createdAt                  | older first               | older first             | older first (unchanged)   |
| Two jobs at the same createdAt, names z / a      | a first (name ASC)        | DB-natural (undefined)  | a first (name ASC)        |
| Job with valid timestamp + another bulk-seeded   | deterministic by name     | undefined by row layout | deterministic by name     |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a parity /
robustness `fix:` on an internal scheduler store, recorded
honestly with this backlog row — not a false metric.

## Decisions

- **Extracted helper over inline edit.** Could have added the
  `.orderBy("name", "asc")` inline on the existing chain and
  shipped a 1-line change. Extracting to a named helper
  unlocks SQL-level testability (the `DummyDriver` + `.compile()`
  pattern that `kysely-stores.test.ts` already uses), so the
  contract is testable without a real Postgres lift.
- **Same name ASC tiebreaker convention.** Matches `compareJobs`
  in `scheduler-helpers.ts` line 128-130 byte-for-byte
  (createdAt ASC primary, name ASC secondary). A future maintainer
  reading either implementation sees the same sort key
  ordering, so an extension (add a third sort key) edits
  both sites in lockstep.
- **Helper kept private to scheduler-stores.ts file, but exported
  from the barrel.** The InMemory class doesn't use it (it
  goes through `compareJobs`); only Kysely calls it. Exporting
  via the barrel makes it consumable by:
  (a) the test that asserts the compiled SQL,
  (b) any future caller (e.g. an admin endpoint that wants
      the same sort with extra `where` filters) that builds on
      this base.
- **Mutation choice.** Tried `removing` the name orderBy rather
  than reversing it because the realistic regression is
  "someone simplifies the chain back to one key during a
  refactor." A reversal mutation would also be valid but is
  a less likely accidental change.
- **Did NOT add a similar id-tiebreaker to
  `listMessages` / `listToolCalls` in the
  `run-history.ts` Kysely store.** Those are also asymmetric
  with the in-memory comparator (in-memory has the `id` ASC
  tiebreaker, Kysely does not). Kept scope tight on the
  scheduler defect; the run-history Kysely tiebreaker gap
  belongs in a follow-up iteration to avoid bundling two
  unrelated tables into one commit.

## Remaining risks

- **`KyselyAgentRunHistoryStore.listMessages` / `listToolCalls`
  parity gap** — same defect class, different file, deferred.
  The InMemory comparators in `run-history.ts:622-628` have
  the id ASC tiebreaker; the Kysely paths use
  `orderBy("created_at", "asc")` only.
- **`KyselyScheduledJobExecutionStore.findByJobId` /
  `findRecent`** — neither has a tiebreaker on `started_at`
  DESC, and the in-memory equivalents use `executions.slice(...)`
  of an `unshift`-ordered array (LIFO insertion order — not a
  comparator). The two paths agree under monotonic save order
  but diverge if saves arrive out of order. Out of scope.
- **`KyselyScheduledJobStore.list`** doesn't take a `limit` /
  `offset` parameter. If the table ever scales past a single
  page of UI, the call returns the full table sorted in
  memory. Not relevant on a personal-JARVIS single-user box,
  but worth flagging.
