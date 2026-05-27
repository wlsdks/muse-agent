# 733 — fix: `/api/today` + CLI followups order by instant (completes 732 across surfaces)

## Why

732 fixed the lexicographic reminder sort in the CLI's local
`muse today`, but a grep for the same bug class (`localeCompare` on a
timestamp field) surfaced three more live sites doing chronological
ordering by raw ISO string:

- `apps/api/src/today-routes.ts` — the `GET /api/today` route (the path
  the DEFAULT `muse today` uses, before its `--local` fallback) sorted
  reminders by `dueAt.localeCompare` and followups by
  `scheduledFor.localeCompare`. So the remote briefing still mis-ordered
  exactly what 732 fixed locally.
- `apps/cli/src/commands-today.ts` — 732 fixed its reminders but left the
  followups sort lexicographic.

`dueAt` / `scheduledFor` are free-form (relative-phrase grammar, hand
edits, imports), so mixed precision / timezone offsets sort wrong (a
`…-05:00` item whose instant is later sorts before an earlier `…Z` one),
surfacing a later item as the most imminent.

Same bug class as 722 (ICS TZID) / 732; this completes the briefing
ordering across both surfaces and both entity types.

## Slice

- `today-routes.ts`: reminders → `compareRemindersByDueAt`, followups →
  `compareFollowupsByScheduledFor` (both already exported + correct,
  Date.parse instants — `muse reminders` already uses them).
- `commands-today.ts`: followups → `compareFollowupsByScheduledFor`
  (reminders were fixed in 732). `readDueFollowups` exported for a
  direct test.

## Verify

- `@muse/api` server.today.test.ts: `GET /api/today?lookaheadHours=168`
  with a `-05:00`-offset reminder + followup (later instant, earlier raw
  string) returns both in instant order (`[r_b, r_a]`, `[f_b, f_a]`).
  **Mutation-proven** — reverting the reminder sort to `localeCompare`
  fails it.
- `@muse/cli` commands-today.test.ts: `readDueFollowups` orders a
  `-05:00`-offset followup after an earlier `Z` one.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). No LLM path
  touched — pure ordering.

## Decisions

- **Reuse the canonical comparators, don't re-implement** — the stores
  own the correct Date.parse ordering and other surfaces (`muse
  reminders`, `muse today --local` after 732) use them; routing the
  remaining sites through the same comparator both fixes the bug and
  guarantees every "what's due" surface agrees.
- **Left `muse remind list` / `muse followup list` for a follow-up** —
  they have the same inline string-sort (`commands-remind.ts:179`,
  `commands-followup.ts:64`); this slice scoped to the `today` briefing
  (API + CLI) to stay one coherent change. The list commands are a
  separate, smaller follow-up.
