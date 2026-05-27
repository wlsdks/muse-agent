# 551 — `muse remind list --local` adds asc-by-id tiebreaker for entries sharing `dueAt` (goal-537 deferred remainder)

## Why

Goal 537 closed the CLI-side id-tiebreaker convention on
`muse followup list` and `muse today --local` (both reminders +
followups sub-arrays), pairing the API-side fix from goal 533.
The "Remaining risks" section of goal 537 explicitly flagged
the last outlier:

```ts
// apps/cli/src/commands-remind.ts:178 — `muse remind list --local`:
const sorted = [...filtered].sort((left, right) => left.dueAt.localeCompare(right.dueAt));
```

Same sibling-asymmetry defect class as goals 519 / 530 / 531 /
533 / 537 / 546. When the user invokes
`muse remind list --local`, the comparator reads directly from
`.muse/reminders.json` and renders the sorted result. If two
reminders share the same `dueAt` (the daily-routine reminder
fired by a script at the top of the hour; two `muse remind`
captures emitted in the same agent turn), JavaScript's stable
sort yields to file-read insertion order — and that order
changes whenever anything upstream reorders the JSON array.
Two consecutive `muse remind list --local` invocations could
return identical contents in different orders, breaking the
"identical persisted data → identical render" contract that
the surrounding 519/530/531/533/537/546 sweep established.

Closing this last single-key sort completes the cross-codebase
comparator-determinism convention.

## Slice

- `apps/cli/src/commands-remind.ts:178` — added asc-by-id
  tiebreaker:
  ```ts
  const sorted = [...filtered].sort((left, right) =>
    left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id)
  );
  ```
- `apps/cli/test/program.test.ts` — added one focused
  `it(...)` immediately after the existing
  `muse remind list rejects --status typos with a closest-match
  hint (goal 137)` test: three reminders sharing the same
  `dueAt`, inserted into the file as `["rem_b", "rem_a",
  "rem_c"]`, must list as `["rem_a", "rem_b", "rem_c"]`
  through `muse remind list --local --json` regardless of
  insertion order.

Direction matches goal 537: asc primary key (dueAt), asc id
tiebreaker. Reader sees most-overdue first; ties break
alphabetically. Consistent with the surrounding CLI render
paths.

## Verify

- New `it(...)` green within the existing describe block; full
  `@muse/cli` suite green (982 passed, +1 vs baseline 981, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting
  `commands-remind.ts:178` to the bare single-key comparator
  makes the new test fail with the precise pre-fix symptom —
  `ties on dueAt resolve by id asc — independent of
  file-array insertion order: expected [ 'rem_b', 'rem_a',
  'rem_c' ] to deeply equal [ 'rem_a', 'rem_b', 'rem_c' ]`.
  The fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green (apps/api 244
  passed, apps/cli 982 passed); `pnpm lint` 0/0; `pnpm
  guard:core` clean; byte-scan clean; `git status` shows only
  the three intended files (`commands-remind.ts`,
  `program.test.ts`, `README.md`).
- Pure comparator — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is
  `muse remind list --local`, not the model loop.

## Status

Done. The id-tiebreaker convention now reads identically
across **every** time-keyed sort I can find in the codebase:

- API server-side: `/api/today` reminders/followups/tasks
  (goal 533)
- CLI local-mode renders:
  - `muse followup list --local` (537)
  - `muse today --local` reminders + followups (537)
  - `muse remind list --local` (this goal)
- Other persistence-render paths: `vacuumEpisodes` (519),
  `queryActionLog` (530), `suggestPatternHints` (531),
  `compareFeedEntriesNewestFirst` (546)

A future grep for time-keyed `.sort((left, right) =>
left.X.localeCompare(right.X))` with no `|| left.id...` clause
should return zero hits in the render-path CLI / API / store
code. The convention is the codebase standard.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry
comparator-determinism `fix:` on the last single-key CLI
render-path sort, recorded honestly with this backlog row —
not a false metric.

## Decisions

- Step-8 continuation from goal 537 onto the deferred outlier
  it explicitly named in "Remaining risks". One-iteration-
  per-area scope kept goal 537 reviewable; this iteration
  finishes the convention pair the way that note promised.
- Matched the tiebreaker direction (asc primary + asc id) to
  the surrounding 537/533/531 convention. Reader expectation
  is consistent across every list command.
- The test fits naturally as a fresh `it(...)` rather than
  extending the existing goal-137 typo test: the goal-137
  test exercises typo-error paths against `--api-url`
  (so the local-mode `--local --json` path doesn't fit its
  fixture). A new test with its own
  `MUSE_REMINDERS_FILE`-scoped env + JSON fixture mirrors
  goal 537's followup-list pattern byte-for-byte.
- Considered widening `serializeReminder` or the sort to use
  `createdAt` as the tiebreaker (so the earliest-captured of
  two same-dueAt reminders surfaces first). Rejected: `id`
  is the established surface convention across 533/537/546
  and is guaranteed unique; `createdAt` is monotonic in
  practice but not enforced by the schema, so an id-asc
  tiebreaker is the strictly-stronger invariant.
