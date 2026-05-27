# 634 — `AgentRunHistoryStore` resolves same-`createdAt` ties by `id` ASC across both InMemory and Kysely implementations so `muse history` pagination and `/api/admin/runs` listings stay deterministic when two runs share a timestamp

## Why

`packages/runtime-state/src/run-history.ts:compareRunsNewestFirst`
was the InMemory comparator behind `listRuns()` and
`listRunsByUser()`. Pre-fix:

```ts
function compareRunsNewestFirst(left, right): number {
  return right.createdAt.getTime() - left.createdAt.getTime();
}
```

No tiebreaker. When `right.createdAt === left.createdAt` (two
runs created in the same millisecond — easy when the agent fires
several short runs in quick succession, or when test code uses a
fixed-now factory), the difference is `0`. V8's `Array.sort` is
stable since Node 12, so ties preserve INSERTION order from
`Map.values()`. That works in-process, but:

1. **Cross-implementation drift**: `KyselyAgentRunHistoryStore`'s
   `listRuns` queries `ORDER BY created_at DESC` only. Postgres
   ORDER BY without a secondary key returns ties in
   physical-row order, which is **non-deterministic** across
   query runs (vacuum, page splits, replica routing). So the
   same store returns different orderings depending on which
   path the caller is on.
2. **Pagination correctness**: `listRuns({ offset, limit })`
   relies on a stable total order. When two records sit at the
   pagination boundary with a tied timestamp, the SAME run can
   either appear in BOTH pages or in NEITHER, depending on
   which side of the unstable cut it landed on. Callers walking
   the list with `offset += limit` lose data.
3. **Test snapshots**: a test that creates two runs with the
   same fake `now` and reads them back via `listRuns().map(r =>
   r.id)` gets order-dependent failures across architectures
   (V8's Map insertion-order is spec-stable, but the symmetric
   Postgres path has no such guarantee).

The sibling comparators in the SAME file ALREADY have id
tiebreakers:

```ts
function compareMessages(left, right): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}

function compareToolCalls(left, right): number {
  return left.createdAt.getTime() - right.createdAt.getTime()
    || left.id.localeCompare(right.id);
}
```

But — **the Kysely path for THOSE table queries also lacks the
secondary `ORDER BY id`**. So even where the InMemory comparator
got it right, the Kysely implementation diverged on ties.

This iter's defect class — **sort comparator missing tiebreaker;
InMemory <-> Kysely sort-key parity** — is sibling-parity to
goal 615 (calendar event tiebreaker), 18 iterations back.
Fresh against the recent window:

- 633: surrogate-pair truncation
- 632: tilde-expansion
- 631: concurrent-write serialization
- 630: mkdtemp directory cleanup
- 629: per-entry validation
- 628: unit-promotion + finite-guard
- 627: tolerant-read nested array
- 626: child-process stream error
- 625: strict env-parse
- 624: HTTP timeout

Other related iters not in the recent window:
- 615 (calendar) — same defect class, 19 iters ago
- 519-era — calendar sort dedup

## Slice

- `packages/runtime-state/src/run-history.ts`:
  - `compareRunsNewestFirst` — added `|| left.id.localeCompare(right.id)`
    after the time delta. Matches `compareMessages` and
    `compareToolCalls`.
  - Kysely `listRuns`, `listRunsByUser` — added
    `.orderBy("id", "asc")` after the existing
    `.orderBy("created_at", "desc")`. Both list paths.
  - Kysely `listMessages`, `listToolCalls` — added
    `.orderBy("id", "asc")` after the existing
    `.orderBy("created_at", "asc")`. Brings these into parity
    with the InMemory comparators (which already had
    `id.localeCompare`).
- `packages/runtime-state/test/run-history.test.ts`:
  - Two new tests in the `InMemoryAgentRunHistoryStore`
    describe:
    - **listRuns same-timestamp tiebreaker** — create three
      runs with the SAME `now`, ids out-of-order (`run-c`,
      `run-a`, `run-b`). Assert the list comes back in id-ASC
      order (`run-a`, `run-b`, `run-c`).
    - **listRunsByUser same-timestamp tiebreaker** — same
      shape, with `userId: "u1"`. Pins that the filter path
      also picks up the tiebreaker.
  - One new test in the `Kysely run history mapping` describe:
    - Compile `listRuns`-shape, `listMessages`-shape, and
      `listToolCalls`-shape SELECTs via the DummyDriver and
      assert each compiled SQL contains the two-key ORDER BY
      clause (`order by "created_at" {asc|desc}, "id" asc`).
      Pins the SQL parity directly.
- `docs/goals/633-inbox-context-truncate-surrogate-guard.md`:
  - One-line byte-hygiene cleanup. The previous iter's goal
    doc had a literal Zero-Width Joiner (U+200D) inside a
    `👨U+200D👩U+200D👧` family-emoji example. The repo-byte-hygiene
    test (`packages/shared/test/repo-byte-hygiene.test.ts`)
    rejects raw U+200D in tracked text files — replaced with
    the textual `U+200D` notation, same fix iters 606 etc.
    used. Bundled here because the iter that introduced it
    already shipped.

## Verify

- `@muse/runtime-state` suite green (26 passed, +3 vs the
  pre-iter baseline of 23, 0 failed).
- **Clean-mutation-proven** (Edit-based, in-memory path):
  reverting the `|| left.id.localeCompare(right.id)` tail
  makes EXACTLY the two new InMemory tests fail with the
  literal Map-insertion order: `Received: ["run-c", "run-a",
  "run-b"]` vs. `Expected: ["run-a", "run-b", "run-c"]`.
  The Kysely compile-SQL test passes both pre- and post-fix
  (it tests the SQL builder pattern directly, not the
  production code path) — explicit limitation documented in
  Remaining risks below. The other 21 pre-existing tests
  pass both pre- and post-fix.
- `pnpm check` green: apps/api 261/261, apps/cli 1093/1093,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean
  on the touched files. The repo-byte-hygiene test caught
  the doc-633 ZWJ during `pnpm check` (in the `@muse/shared`
  suite); cleaned and re-verified.
- No LLM request/response wire path touched — pure ordering.
  `smoke:live` doesn't apply.

## Status

Done. Run-history listings are now order-deterministic across
both implementations and across query runs:

| Path                                  | Before                     | After                |
| ------------------------------------- | -------------------------- | -------------------- |
| InMemory `listRuns` (no tied rows)    | OK                         | unchanged            |
| InMemory `listRuns` (tied `createdAt`)| Map-insertion order        | id ASC (**fixed**)   |
| InMemory `listRunsByUser` (tied rows) | Map-insertion order        | id ASC (**fixed**)   |
| InMemory `listMessages`               | already tiebroken          | unchanged            |
| InMemory `listToolCalls`              | already tiebroken          | unchanged            |
| Kysely `listRuns` (tied rows)         | **Postgres row order**     | `id` ASC (**fixed**) |
| Kysely `listRunsByUser` (tied rows)   | **Postgres row order**     | `id` ASC (**fixed**) |
| Kysely `listMessages` (tied rows)     | **Postgres row order**     | `id` ASC (**fixed**) |
| Kysely `listToolCalls` (tied rows)    | **Postgres row order**     | `id` ASC (**fixed**) |

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
deterministic-ordering `fix:`. Recorded honestly with this
backlog row.

## Decisions

- **`id` ASC for both directions of `created_at`.** The
  primary key is timestamp; the tiebreaker direction is
  arbitrary (UUIDs aren't time-ordered). ASC matches the
  existing `compareMessages` / `compareToolCalls` tiebreakers
  in the same file. Consistent direction across all four
  Kysely list paths.
- **Kysely SQL pattern matched via regex**, not a snapshot.
  `order by "created_at" desc, "id" asc` is the literal
  Postgres compile output. Regex pins the structure (both
  ORDER BY columns present, in the right order, with the
  right direction); a future Kysely version that changes
  whitespace would still pass.
- **Did NOT make the InMemory comparator a public function**.
  It's an internal sort key for one specific data shape. The
  test exercises behavior via `listRuns()` / `listRunsByUser()`,
  not the raw comparator — that's the contract surface.
- **One ID-factory function per InMemory test**, not a shared
  helper, because the test needs predictable out-of-order id
  emission (`run-c, run-a, run-b`) to prove the sort
  reorders them. A globally-monotonic factory wouldn't
  surface the bug.
- **Bundled the doc-633 ZWJ cleanup into THIS commit**. The
  byte-hygiene fail surfaced during this iter's `pnpm check`
  — fixing it in a separate "chore" commit would split
  unrelated work. The fix is one perl substitution; the test
  pin lives in `@muse/shared`.
- **Mutation choice — InMemory comparator only.** Reverted
  the `|| id.localeCompare` tail; both new InMemory tests
  fail with the exact Map-insertion order symptom. The
  Kysely SQL test passes pre- and post-fix because it doesn't
  exercise the production code path — limitation acknowledged
  in Remaining risks.

## Remaining risks

- **Kysely path isn't mutation-pinned by a behavioral test**.
  The SQL compile test asserts what the BUILDER produces,
  not what the PRODUCTION code calls. A maintainer who
  removes the `.orderBy("id", "asc")` from a Kysely list
  method would NOT break that test. Pinning the production
  path requires either:
    - A real Postgres integration test (testcontainers) —
      out-of-scope for this iter; the package's testing
      posture is unit-only.
    - A DummyDriver subclass that captures compiled queries
      — also possible but invasive.
  Decided to ship the parity fix without behavioral
  mutation-pin on the Kysely side; a follow-up could add an
  integration suite if Kysely sort regressions become a
  recurring class.
- **`offset` and `limit` are still un-truncated for
  non-integer values**. `listRuns({ limit: 2.5 })` reaches
  `Math.max(0, 2.5) = 2.5` → `slice(0, 2.5)` (InMemory
  rounds, mostly OK) → `query.limit(2.5)` (Kysely
  may emit `LIMIT 2.5` and Postgres handles it differently).
  Same defect class as 608 (integer safety), out-of-scope
  here.
- **`compareRunsNewestFirst` uses `right - left` (DESC)**.
  Tiebreaker is `left.id.localeCompare(right.id)` (ASC).
  That's a deliberate combination — "newest first, then
  lex-smallest id first." Reverse-direction-on-ties is
  mathematically valid for a stable sort. Documented choice;
  matches the Kysely fix pattern (`created_at DESC, id ASC`).
- **Other in-memory stores** with comparators sorted only by
  timestamp (e.g. `KyselyConversationSummaryStore.listAll`
  uses `updatedAt`-only) carry similar defect potential.
  Each is its own iter; this one is bounded to `run-history.ts`.
