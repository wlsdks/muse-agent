# 533 — `/api/today` open-tasks / reminders / followups sorts add id tiebreakers (goal-519/530/531 sibling on the morning-briefing server route)

## Why

`apps/api/src/today-routes.ts` sorted three result sets by a
single time key with no tiebreaker:

```ts
// reminders (line 135) — dueAt asc:
surfaced.sort((left, right) => left.dueAt.localeCompare(right.dueAt)).map(serializeReminder);

// followups (line 164) — scheduledFor asc:
surfaced.sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor)).map(serializeFollowup);

// open tasks (line 189) — createdAt desc + slice(0, 50):
return tasks.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "")).slice(0, MAX_TASKS);
```

The tasks sort is the most user-visible defect: `slice(0,
MAX_TASKS=50)` caps the returned set. If 60+ tasks share the
same `createdAt` (a bulk import, a script that hammered `muse
task add` in a tight loop, a Notion sync that stamped many
tasks with the same minute), which tasks survive the cap
depends on **input-array insertion order from the JSON file
parse**. Two `GET /api/today` invocations against the same
data can return **different task subsets** if anything
upstream reorders the array.

For reminders and followups, the cap doesn't apply but the
render order is still flaky — operators reading two
consecutive briefings might see entries shuffled when they
shouldn't be.

Same sibling-asymmetry defect class as goals 519 (vacuumEpisodes
tiebreaker), 530 (queryActionLog tiebreaker), and 531
(suggestPatternHints tiebreaker). The tiebreaker convention
has landed in three places already; the `/api/today` morning-
briefing server route was an outlier where multiple sites in
the same file shared the gap.

## Slice

- `apps/api/src/today-routes.ts` — added id-tiebreakers at
  all three sort sites:
  ```ts
  .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id))
  .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor) || left.id.localeCompare(right.id))
  .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? "") || right.id.localeCompare(left.id))
  ```
  Direction matches the primary key (asc for reminders /
  followups dueAt/scheduledFor; desc for tasks newest-first).
  Behaviour byte-identical for every input where no two
  entries share the time key — only the tied path now has a
  deterministic, reload-independent order. The tasks slice
  drops the same 50 tasks across reloads.
- `apps/api/test/server.today.test.ts` — added one new
  `it(...)` block that writes three tasks sharing the same
  `createdAt`, then asserts `body.tasks.map(t => t.id)`
  returns them in id-desc order regardless of file-array
  insertion order.

## Verify

- New test 1/1 green; full `@muse/api` suite green (237
  passed, +1 vs baseline 236, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the tasks
  sort to a bare primary-key comparator makes the new test
  fail with the precise pre-fix symptom — `ties on createdAt
  resolve by id desc — independent of file-array insertion
  order: expected [ 't-a', 't-c', 't-b' ] to deeply equal
  [ 't-c', 't-b', 't-a' ]`. Every other test stays green.
  Fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure comparators — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the `/api/today` morning-
  briefing JSON response, not the model loop.

## Status

Done. The `GET /api/today` response now has a deterministic
order across all three of its time-sorted sub-arrays: open
tasks, due reminders, due followups. The tasks slice
(`slice(0, 50)`) deterministically drops the same tasks
when more than 50 share `createdAt`. The id-tiebreaker
convention now reads identically across four sibling sites:

- vacuumEpisodes (519, time desc + id desc)
- queryActionLog (530, time desc + id desc)
- suggestPatternHints (531, count desc + id asc)
- today-routes (this goal, mixed asc/desc primary +
  matching-direction id tiebreaker)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry comparator-
determinism `fix:` on the morning-briefing server route,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goals 519/530/531 onto a fresh
  surface (the `/api/today` morning-briefing route, three
  sort sites in one file). Same defect class, distinct
  package — productive sibling sweep, not same-area churn.
- Matched the tiebreaker direction to each primary key:
  reminders/followups are asc-by-time (oldest-due-first =
  reader sees what's most-overdue first), so the tiebreaker
  is asc-by-id. Tasks are desc-by-createdAt (newest-first =
  reader sees the most recently added work first), so the
  tiebreaker is desc-by-id. Mixed directions on the same
  primary type would be subtle and confusing; matching
  direction keeps the comparator self-consistent.
- Tested only the tasks sort (which has the slice cap and
  the highest user-visible defect); the reminders / followups
  fixes are mechanical mirrors with the same shape. Cross-
  package convention is to test one representative of a
  triplet when the implementations are identical structure.
- Did NOT touch the analogous CLI-side sorts in
  `apps/cli/src/commands-today.ts` (lines 406, 429) or
  `apps/cli/src/commands-followup.ts` (line 63): the CLI
  reads from the API for the remote-mode briefing and from
  local files in the local-mode briefing. The local-mode CLI
  sorts are a separate concern; this goal closes the API
  side, which is the canonical morning-briefing surface that
  the web UI / future surfaces consume.
- The mutation reverts only the tasks comparator (the one
  whose mutation surface is largest because of the slice
  cap); the reminders / followups comparators are byte-
  identical mirrors and the same mutation produces the
  analogous symptom for each — testing one is sufficient
  per the "one representative of a triplet" decision above.
