## 865 — fix: `muse remind list` shows which reminders repeat

## Why

861 added recurring reminders (`--repeat daily|weekly`) — stored,
functional (fireReminder re-arms), and shown on `add` ("(repeats
weekly)"). But `muse remind list` rendered only id / dueAt / text /
(fired) — so a recurring reminder was **indistinguishable from a
one-shot** in the list. A user who set "every Monday: standup" couldn't
tell, when reviewing their reminders, which ones recur — a real UX seam
left open by 861 (the recurrence is invisible exactly where the user
audits their reminders).

## Slice

`apps/cli` commands-remind.ts `formatReminderList`: append
` (repeats <daily|weekly>)` to a reminder's line when it carries a
`recurrence` (the field `serializeReminder` already emits). One-shots
are unchanged.

## Verify

`apps/cli` commands-remind.test.ts (+1): create a `--repeat weekly`
reminder and a one-shot via `--local`, then `list --local` — the
recurring one renders "standup (repeats weekly)" and the one-shot
carries no repeats suffix (negative-lookahead assertion).
- **Mutation-proven**: dropping the `${repeats}` suffix fails the test.
- `pnpm check` EXIT 0, `pnpm lint` 0/0. (Pure formatter + CLI — no LLM
  path.)

## Decisions

- A list view is where the user audits standing reminders; surfacing
  recurrence there closes the 861 seam at the point of need. The
  `add` confirmation already showed it; this makes the persistent view
  consistent.
- No new dependency.
