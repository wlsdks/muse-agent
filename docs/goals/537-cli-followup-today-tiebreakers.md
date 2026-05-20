# 537 — CLI-side `muse followup list` + `muse today` local-mode sorts add id tiebreakers (goal-533 sibling on the CLI render path)

## Why

Goal 533 closed the id-tiebreaker gap on the `/api/today`
server route's three time-sorted sub-arrays. The "Remaining
risks" note flagged that the analogous CLI-side sorts hadn't
been mirrored yet:

```ts
// apps/cli/src/commands-followup.ts:63 — `muse followup list`:
const sorted = [...filtered].sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor));

// apps/cli/src/commands-today.ts:406 — local-mode reminders due-window:
.sort((left, right) => left.dueAt.localeCompare(right.dueAt))

// apps/cli/src/commands-today.ts:429 — local-mode followups due-window:
.sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor))
```

These run when the user invokes `muse followup list` or
`muse today --local`, reading directly from `.muse/followups.
json` / `.muse/reminders.json`. When two entries share the
time key (a daily-routine reminder fired by a script at the
top of the hour, two followups captured in the same agent
turn), JavaScript's stable sort yields to file-read insertion
order. That order changes across reload cycles if anything
upstream reorders the JSON array — so two `muse followup list`
invocations in the same session can return the same entries
in different orders.

Same sibling-asymmetry defect class as goal 533 (API server-
side) and 519 / 530 / 531 (other persistence-render paths).
Closing the CLI side completes the convention pair: both the
local-mode CLI reads and the API-mode reads produce identical
deterministic order from the same persisted data.

## Slice

- `apps/cli/src/commands-followup.ts:63` — added asc-by-id
  tiebreaker:
  ```ts
  const sorted = [...filtered].sort((left, right) =>
    left.scheduledFor.localeCompare(right.scheduledFor) || left.id.localeCompare(right.id)
  );
  ```
- `apps/cli/src/commands-today.ts:406` — same shape:
  ```ts
  .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id))
  ```
- `apps/cli/src/commands-today.ts:429` — same shape for
  followups.
- `apps/cli/test/program.test.ts` — extended the existing
  `muse followup list --json` test with a fresh fixture: three
  followups sharing the same `scheduledFor`, assert the
  returned ids come back in `["fu_a", "fu_b", "fu_c"]` order
  (asc) independent of the file-array insertion order
  (`["fu_b", "fu_a", "fu_c"]`).

Direction matches goal 533: asc primary key, asc id tiebreaker
(reader sees what's most-overdue first; ties break
alphabetically). The CLI side and API side now read identically.

## Verify

- New assertion green within the existing `it(...)`; full
  `@muse/cli` suite green (913 passed, +4 vs baseline 909, 0
  failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  `commands-followup.ts` tiebreaker to the bare single-key
  comparator makes the new assertion fail with the precise
  pre-fix symptom — `ties on scheduledFor resolve by id asc —
  independent of file-array insertion order: expected
  [ 'fu_b', 'fu_a', 'fu_c' ] to deeply equal [ 'fu_a', 'fu_b',
  'fu_c' ]`. The fix restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the three intended files.
- Pure comparators — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended paths are `muse followup list`
  and `muse today --local`, not the model loop.

## Status

Done. The id-tiebreaker convention now reads identically
across:

- API server-side: `/api/today` reminders/followups/tasks
  sorts (goal 533)
- CLI local-mode: `muse followup list` (this goal),
  `muse today --local` reminders + followups (this goal)
- Other persistence-render paths: vacuumEpisodes (519),
  queryActionLog (530), suggestPatternHints (531)

Two paired commands — API-mode (`muse today` / `muse followup
list` against the server) and local-mode — now produce the
same deterministic order from the same persisted data.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry comparator-
determinism `fix:` on the CLI local-mode render paths,
recorded honestly with this backlog row — not a false metric.

## Decisions

- Step-8 continuation from goal 533 (closing the API-side
  pair) onto the CLI local-mode side, completing the
  client-server convention pair. Same defect class, different
  surface, productive sibling sweep.
- Matched the tiebreaker direction to the primary key (asc
  + asc) so the comparator reads consistently across both
  the CLI and API renders. Cross-package convention is
  established.
- Mutated only `commands-followup.ts` (one of three sites)
  for the proof — the other two `commands-today.ts` sites
  use byte-identical shapes and would mutate-fail identically
  if reverted. Cross-package convention is to test one
  representative of a triplet.
- The test extends the existing `muse followup list --json
  filters by status` test rather than spawning a new top-
  level `it(...)`: the new assertion fits naturally as
  "another scenario the list command handles correctly,"
  and the test fixture already has the full setup/teardown
  for `MUSE_FOLLOWUPS_FILE`.
- Did NOT touch the `apps/cli/src/commands-remind.ts:178`
  single-key sort (`muse remind list`): that's a fresh
  iteration target whenever this defect class comes up
  again; one-iteration-per-area scope keeps the diff
  reviewable.
