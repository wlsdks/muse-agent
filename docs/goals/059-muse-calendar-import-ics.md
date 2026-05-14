# 059 — muse calendar import <file.ics>

## Why

Read an .ics file + create matching events in the local provider.
One-shot bulk import.

## Scope

- New subcommand under muse calendar.
- node-ical or hand-rolled parser.
- Idempotent via uid.

## Verify

- cli + calendar test.

## Status

done — `muse calendar import <file.ics> [--dry-run]
[--allow-duplicates] [--json]` reads an iCalendar file, parses
VEVENT blocks via the new hand-rolled `parseIcsEvents` helper
in `apps/cli/src/ics-parser.ts`, and feeds each through
`LocalCalendarProvider.createEvent`.

Idempotency is by `(title, startsAt)` against existing events
in the bounding date range — re-running the same import doesn't
duplicate. `--allow-duplicates` bypasses for the rare bulk-merge
case; `--dry-run` reports what would land without touching disk.

Scope discipline — the parser is intentionally minimal: VEVENT
blocks only, no RRULE / VTIMEZONE / attendee expansion. Those
need a real iCalendar library (node-ical) that we'd rather not
take a dep on for a one-shot manual importer. If a future goal
needs recurrence, swap the implementation; the `parseIcsEvents`
export stays.

cli +1 unit test asserts the parser covers timed events,
`VALUE=DATE` all-day, line escapes (`\\n`), missing `DTSTART`
skip, and ordering.
