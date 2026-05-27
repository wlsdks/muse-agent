# 722 — fix: `muse calendar import` honours `TZID`, so zoned events don't land hours off

## Why

The ICS parser (`apps/cli/src/ics-parser.ts`, behind `muse calendar
import`) ignored a `DTSTART;TZID=America/New_York:20260118T090000` param
and read the unsuffixed wall-clock as **UTC** — so a 9am New York meeting
was imported as 09:00Z (= 4am NY, five hours early). Real exported
calendars almost always carry `TZID`, so this silently put imported
events at the wrong absolute time. The module documented timezones as
out of scope, but that note is about stateful RRULE / VTIMEZONE
*expansion*; honouring a named IANA zone is a pure per-value conversion
that the built-in `Intl` handles with no dependency.

Rotated surface (PROCEDURE Step 8: recent iterations churned
messaging/channel, cli-actions, vision, model, proactive — this is the
calendar/perception surface).

## Slice

- `splitContentLine`: capture the `TZID` param, preserving the value's
  original case (IANA ids are case-sensitive for `Intl`) and stripping
  RFC-5545 quotes; `VALUE=DATE`/`TZID` matched case-insensitively.
- `parseIcsDateValue(raw, isDate, tzid?)`: for an unsuffixed timed value
  with a known IANA `TZID`, convert the wall-clock to the real UTC
  instant via `zonedWallClockToUtc` (built-in `Intl`, two refinement
  passes for DST-boundary correctness). `Z` still wins (UTC); an unknown
  zone falls back to the prior UTC reading — strictly more events
  correct, none worse, none dropped.

## Verify

- `@muse/cli` ics-parser.test.ts (1259 tests): America/New_York winter
  (EST, UTC-5) 09:00→14:00Z and summer (EDT, UTC-4, DST) 09:00→13:00Z;
  Asia/Seoul (UTC+9) 09:00→00:00Z; quoted `TZID="…"`; a `Z` suffix wins
  over `TZID`; an unknown zone (`Mars/Phobos`) falls back to the UTC
  reading rather than dropping the event.
- **Mutation-proven**: removing the conversion branch fails the TZID
  tests. Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — pure date parsing.

## Decisions

- **Built-in `Intl`, not a tz dependency** — zero-cost / no-new-dep
  constraint; `Intl.DateTimeFormat` knows the IANA database, and a
  two-pass offset computation resolves DST-boundary times correctly.
- **Fall back to UTC for unknown zones, never drop** — an exotic or
  custom `TZID` (not an IANA name) keeps the old behaviour rather than
  failing the import; the change can only improve accuracy.
- **`Z` wins over `TZID`** — defensive: a value with both is malformed,
  but `Z` is unambiguous UTC, so honour it.
