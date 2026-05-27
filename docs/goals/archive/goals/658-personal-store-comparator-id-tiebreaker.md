# 658 — `compareRemindersByDueAt` / `compareFollowupsByScheduledFor` / `compareTasksByDueDate` add an ASC-by-id tiebreaker after the existing dueAt + createdAt cascade so a bulk import / fast successive create that produces two entries with identical timestamps lands in a deterministic order across runs and processes

## Why

Goal 634 fixed the same defect class for `compareRunsNewestFirst`
(in `packages/runtime-state/src/run-history.ts`). The three
personal-store comparators in `packages/mcp/src/` shipped with
the same shape but without the id tiebreaker:

```ts
return right.createdAt.localeCompare(left.createdAt);
```

When both entries share the same `dueAt` / `scheduledFor` AND
the same `createdAt`, the comparator returns `0` — V8's TimSort
then preserves *insertion order*, which depends on:

- The order entries appear in `~/.muse/{reminders,followups,
  tasks}.json` on disk.
- The order callers append to that list.
- The order an import tool inserts duplicates.

This is **nondeterministic across runs**: a fresh `muse
import` of the same bundle, twice, can surface the same
entries in different orders. The bug manifests on:

- **Bulk imports**: ten reminders all carrying `dueAt =
  "2026-05-15T09:00:00Z"` and `createdAt = (the import
  moment)` — fast-clock created at the same millisecond
  by the importer.
- **Fast successive creates**: `muse remind add` called
  twice in the same second via a shell loop produces two
  records with identical ISO strings.
- **Hand-edited stores**: a user that copies a reminder row
  in their editor leaves two identical timestamps.

In each case the UI (`muse remind list`, the proactive
daemon's "what fires next" decision) might surface one or
the other arbitrarily. A test asserting "the new entry
sorts above the old" would also be flaky against this seam.

Goal 634's fix added `|| left.id.localeCompare(right.id)`
after the cascade. Same one-line fix here.

### Defect class

**Sort comparator non-deterministic on full ties** — same as
goal 634, applied to the three sibling comparators. Last hit:
634, 24 iters ago — well past the 10-iter window for
defect-class rotation (0/10 in the recent window). Fresh
against the recent 10 iters:

- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM private key)
- 655: path-traversal alt-separator
- 654: PKCE (defense-in-depth)
- 653: recursion depth bound
- 652: error msg control-char sanitization
- 651: non-crypto RNG for security token
- 650: LLM timestamp sanity bound
- 649: unbounded HTTP body
- 648: HTTP fetch timeout

## Slice

- `packages/mcp/src/personal-reminders-store.ts`:
  - Final return becomes
    `return right.createdAt.localeCompare(left.createdAt)
    || left.id.localeCompare(right.id);`
- `packages/mcp/src/personal-followups-store.ts`:
  - Same one-line addition.
- `packages/mcp/src/personal-tasks-store.ts`:
  - Same one-line addition (with nullish-coalesce on
    `createdAt ?? ""` preserved). Existing inline comment
    extended with a note about the fall-through.
- `packages/mcp/test/mcp.test.ts`:
  - **Three new `it()` blocks** (one per comparator):
    1. Three entries with IDs `zeta`, `alpha`, `mu` all
       carrying identical dueAt + createdAt → sort produces
       `[alpha, mu, zeta]`.
    2. Same input REVERSED → still produces
       `[alpha, mu, zeta]` (the determinism check).
  Each comparator gets the same two assertions, pinning the
  contract symmetrically.

## Verify

- `pnpm --filter @muse/mcp test`: 541 passed (538 prior + 3
  new it blocks, 6 new expects). `pnpm check` full: every
  workspace green; tsc strict EXIT=0.
- **Clean-mutation-proven**: reverting the
  `|| left.id.localeCompare(right.id)` addition in just
  `compareTasksByDueDate` makes EXACTLY the tasks "falls
  through to id ASC" test fail with the exact symptom —
  insertion order `[zeta, alpha, mu]` leaks through instead
  of `[alpha, mu, zeta]`. The other 2 comparator tests
  (reminders, followups) pass because their tiebreakers
  remain intact. Surgical proof. Restored; all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the four touched files: clean.
- No LLM request/response wire path touched. The
  comparators are pure functions. `smoke:live` doesn't
  apply.

## Status

Done. The three personal-store comparators now order
deterministically on full ties:

| Cascade level                           | Pre-fix              | Post-fix                |
| --------------------------------------- | -------------------- | ----------------------- |
| Distinct dueAt instants                  | sorted by instant ASC | unchanged              |
| Same dueAt, distinct createdAt           | newest createdAt first | unchanged             |
| **Same dueAt AND same createdAt**       | **insertion order** | **id ASC** (deterministic) |
| Unparseable dueAt                        | string ASC          | string ASC + id ASC tiebreaker |

## Decisions

- **`left.id.localeCompare(right.id)` (ASC), not
  descending.** Matches the convention goal 634 set for
  `compareRunsNewestFirst`. The `createdAt` tiebreaker
  uses `right.x.localeCompare(left.x)` (DESC = newest
  first) because creation time has a semantic direction
  (newer = "above"). IDs have no semantic direction —
  ASC is the consistent choice across the codebase.
- **Three identical fixes, not a refactor to share a
  helper.** Each comparator is 8-12 lines of bespoke
  cascade logic; extracting a shared "tiebreak by id"
  utility would obscure rather than clarify. The cost
  is one extra line per file.
- **Tests assert TWO permutations** (forward and reversed
  input) per comparator. Pre-fix TimSort might happen to
  produce the right order for one input ordering but not
  the other — the reversed-input assertion catches that
  flakiness. Goal 634 used the same technique.
- **Did NOT add the tiebreaker to
  `compareFeedEntriesNewestFirst`** (in
  `apps/cli/src/feeds-store.ts:279`). That comparator
  already has id tiebreakers built in at every cascade
  level — it's the model for what these three should
  look like.
- **Mutation choice**. Reverted only the tasks
  comparator's id step. Only the tasks "falls through to
  id ASC" test fails; the reminders + followups
  equivalents pass (their tiebreakers are intact). The
  3 pre-existing dueAt + createdAt tests pass either way
  (they don't tickle the full-tie scenario). Surgical
  proof.

## Remaining risks

- **Tied IDs**. Theoretical: same dueAt, same createdAt,
  same id → returns 0. In practice IDs come from
  `randomUUID()` / `createRunId()` and are practically
  unique. If two records share an id, that's an upstream
  bug (the appender should have rejected the duplicate).
  Not the comparator's job to fix.
- **Other sort sites elsewhere in the codebase** that lack
  id tiebreakers. A grep would find some — each is its
  own iter when defect-class rotation circles back.
- **The comparator contract is `0` on full equality**, so
  TimSort still gets the "stable sort" guarantee
  (V8 19+ is stable). The id tiebreaker only matters
  when `0` would otherwise be returned. For records
  whose distinguishing fields differ, the cascade exits
  early and id is unused — no behavior change.
- **Locale-sensitive `localeCompare`**: in some locales
  (Turkish "i", German "ß") IDs containing those
  letters might sort differently than ASCII expectation.
  All Muse-generated IDs are ASCII (UUIDs / hex), so
  this is a theoretical concern; switching to
  `localeCompare(other, "en", { sensitivity: "case" })`
  would be more rigorous but adds complexity.
