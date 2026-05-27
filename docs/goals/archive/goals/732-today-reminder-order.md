# 732 — fix: `muse today` orders due reminders by instant, not lexicographic dueAt

## Why

`muse today` (the morning briefing) fetches due reminders and sorted
them by `left.dueAt.localeCompare(right.dueAt)` — a lexicographic ISO
compare. `dueAt` is a free-form string (the reminder grammar accepts
ISO or relative phrases; a hand-edited `reminders.json` / import need
not be canonical), so mixed precision or timezone offsets sort wrong:
`2026-05-22T23:00:00-05:00` (= 05-23 04:00Z, LATER) sorts BEFORE
`2026-05-23T01:00:00Z` (EARLIER) lexicographically. The briefing would
then present a later reminder as the most imminent — the opposite of
what "what's due" should show. The reminders store already fixed exactly
this in `compareRemindersByDueAt` (parsed instants + id tiebreaker), but
`muse today` re-implemented the sort by hand and reintroduced the bug.

Rotated surface (PROCEDURE Step 8: the remote-actuation epic is done;
this is the proactive-briefing surface) after confirming episodic
recall, scheduler, telemetry/cost, calendar CRUD, and the status
summaries are all already robust + covered.

## Slice

- `apps/cli/src/commands-today.ts`: `readDueReminders` now sorts the
  filtered pending reminders with the store's canonical
  `compareRemindersByDueAt` (Date.parse instants, deterministic
  tiebreak) instead of `dueAt.localeCompare`. Exported for a direct
  ordering test.

## Verify

- `@muse/cli` commands-today.test.ts: `readDueReminders` returns a
  `-05:00`-offset reminder (later instant) AFTER an earlier `Z`
  reminder, where a lexicographic sort would invert them.
- **Mutation-proven**: restoring the `localeCompare` sort fails the test.
  Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (verified standalone). No LLM
  path touched — pure local sort; the `--brief` synthesis is unchanged.

## Decisions

- **Reuse `compareRemindersByDueAt`, don't re-implement** — the store
  already owns the correct, documented ordering (and `muse reminders`
  uses it); `muse today` reusing it both fixes the bug and keeps the two
  surfaces consistent, rather than duplicating the Date.parse logic a
  third time.
- **The tasks path was already correct** — it imports
  `compareTasksByDueDate`; only the reminders sort had drifted to a
  hand-rolled string compare, so this is a one-line correctness
  alignment, not new machinery.
