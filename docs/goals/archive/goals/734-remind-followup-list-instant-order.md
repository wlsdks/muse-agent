# 734 — fix: `muse remind list` / `muse followup list` order by instant (finishes the 732 bug class)

## Why

732/733 fixed the lexicographic-timestamp sort across the `today`
briefing (CLI + `/api/today`). A grep for the same bug class
(`localeCompare` on a timestamp field) left exactly two live sites —
the direct list surfaces:

- `apps/cli/src/commands-remind.ts:179` — `muse remind list --local`
  sorted by `dueAt.localeCompare(...)`.
- `apps/cli/src/commands-followup.ts:64` — `muse followup list` sorted
  by `scheduledFor.localeCompare(...)`.

`dueAt` / `scheduledFor` are free-form (relative-phrase grammar, hand
edits, imports), so a mixed-precision / timezone-offset value sorts
wrong (a `…-05:00` item whose instant is later sorts before an
earlier `…Z` one). The list — the user's direct window into their
queue — could show a later item above a more-imminent one.

This is the last site in the class; with it, every reminder/followup
ordering surface (`muse today`, `/api/today`, `muse reminders`,
`muse remind list`, `muse followup list`) agrees on instant order.

## Slice

- `commands-remind.ts`: `.sort(compareRemindersByDueAt)`.
- `commands-followup.ts`: `.sort(compareFollowupsByScheduledFor)`.

Both reuse the store's canonical Date.parse comparators (instant
primary, `createdAt`-desc then id-asc tie-break) — no re-implement.

## Verify

- `@muse/cli` commands-remind.test.ts: `muse remind list --local
  --json` with a `-05:00`-offset reminder (later instant, earlier raw
  string) lists `[b, a]`. **Mutation-proven** — reverting to
  `dueAt.localeCompare` fails it.
- `@muse/cli` commands-followup.test.ts (new file): same end-to-end
  assertion for `muse followup list --json`. Mutation-proven.
- Drove both through the real commander program + a temp file via
  `MUSE_REMINDERS_FILE` / `MUSE_FOLLOWUPS_FILE` (real user surface, not
  an extracted helper).
- The pre-existing tie-break tests (`program.test.ts`) still pass: the
  canonical comparator's `createdAt`-equal / id-asc fall-through
  matches the prior `|| id.localeCompare` order.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). No LLM path
  touched — pure ordering, so no `smoke:live`.

## Decisions

- **Drove the test through the real CLI program**, not an extracted
  helper — the sort lives inline in the `.action()` closure, and the
  existing `program.test.ts` tie-break tests already prove the
  end-to-end path is the right seam. Setting `MUSE_*_FILE` + a temp
  file exercises exactly what a user runs.
- **No new OUTWARD bullet flipped** — P8 briefing ordering was
  delivered in 732/733; this is the final hardening of the same bug
  class on the direct-query surfaces, recorded as a CAPABILITIES line.
