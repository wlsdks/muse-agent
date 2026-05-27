# 798 — feat: contact birthdays + `muse contacts birthdays` (people-axis EXPAND)

## Why

A daily-driver JARVIS knows the people in your life — "it's Sarah's
birthday in 2 days". The people graph (`~/.muse/contacts.json`) held
name / email / handle / aliases but no birthday, so Muse could never
remind you. A fresh capability on the people axis (not another
hardening / briefing-line).

## Slice

- `@muse/mcp` personal-contacts-store.ts — `Contact.birthday?`
  (`MM-DD` or `YYYY-MM-DD`; year ignored for the recurring reminder),
  persisted by the existing atomic `writeContacts` and surfaced by
  `serializeContact`. `resolveUpcomingBirthdays(contacts, { now,
  withinDays=30 })` → upcoming birthdays soonest-first, with a
  year-wrap (a date already past this year rolls to next year) and
  missing/malformed dates skipped.
- `apps/cli` commands-contacts.ts — `muse contacts add --birthday
  <MM-DD|YYYY-MM-DD>` (validated) and `muse contacts birthdays
  [--within <days>]` ("🎂 Sarah — in 2 days (12-25)").

## Verify

- `@muse/mcp` personal-contacts-store.test.ts (+3): upcoming birthdays
  within the window soonest-first + year-agnostic; a past-this-year
  date wraps to a POSITIVE daysUntil; beyond-window excluded,
  missing/malformed skipped.
- `apps/cli` commands-contacts.test.ts (+3): `add --birthday`
  round-trips through the REAL store and `birthdays` lists it; a
  malformed `--birthday` is rejected (exit 1); `birthdays` reports
  none when no contact has one.
- **Mutation-proven**: removing the year-wrap → a past date yields a
  negative `daysUntil` → the wrap test fails; restore → green. Full
  `pnpm check` EXIT 0, `pnpm lint` 0/0. No model path → no `smoke:live`.

## Decisions

- **Store round-trips birthday for free** — `writeContacts`
  JSON-stringifies the contact and `readContacts` returns it via the
  id+name `isContact` filter, so the optional field needed only the
  type + `serializeContact`.
- **On-demand CLI surface, not a brief line** — deliberately a fresh
  surface (`muse contacts birthdays`) rather than yet another briefing
  line; the proactive brief integration is a clean follow-on
  (`resolveUpcomingBirthdays` is the reusable engine).
- **Year-agnostic** — only month-day matters for a recurring birthday;
  a `YYYY-` prefix is accepted but ignored.
- A pre-existing load-sensitive 5s-timeout flake in
  `voice-playback.test.ts` surfaced once under full-suite parallelism;
  it passes in isolation and on a clean `pnpm check` retry — unrelated
  to this change.
