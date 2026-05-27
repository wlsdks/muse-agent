# 454 — CalDAV VEVENT parsing ignores a preceding VTIMEZONE DTSTART

## Why

`parseVEvent` (`@muse/calendar` `caldav-provider.ts`) is the pure
ICS parser behind CalDAV calendar reads — a primary JARVIS
calendar provider (Fastmail / Nextcloud / iCloud / Google-via-
CalDAV). `parseCalendarQueryResponse` passes the **entire**
`<C:calendar-data>` VCALENDAR text (line 240) into `parseVEvent`,
which then reads properties with `matchIcsLine`, whose
`ics.match(re)` returns the **first** match in the whole string.

For the single most common real-world case — an event with a
named timezone (`DTSTART;TZID=America/New_York:…`) — the server
inlines a `VTIMEZONE` component (RFC 5545 requires the TZID to be
defined). `VTIMEZONE`'s `STANDARD` / `DAYLIGHT` sub-components
each carry a DST-rule `DTSTART:` line (e.g.
`DTSTART:20070311T020000`), and the VTIMEZONE precedes the VEVENT
in standard VCALENDAR ordering. So `matchIcsLine(ics, "DTSTART")`
returned the **2007 DST-rule date as the event's start** — every
timezone-qualified CalDAV event was parsed with a ~2007 time,
silently corrupting "what's next" / proactive surfacing /
calendar-imminence for any non-floating event.

The existing TZID test passed only because it omitted the
VTIMEZONE that a real server always emits — giving a false sense
of TZID safety; the VTIMEZONE-before-VEVENT case was **genuinely
uncovered**. This is the textbook ICS-parsing footgun, not
speculative; it triggers on the most common production input.
Fresh package (calendar last touched goal 424, ~30 iterations
ago); a structural-parsing correctness `fix:`, a different defect
class than the recent run.

## Slice

- `packages/calendar/src/caldav-provider.ts` — `parseVEvent` now
  unfolds, then extracts the first
  `BEGIN:VEVENT … END:VEVENT` body and matches properties within
  **that** block only (falling back to the whole string if no
  VEVENT delimiters — preserves behaviour for bare-VEVENT
  servers). One regex, scoped before the existing property
  matchers; everything downstream is unchanged. A `VALARM`
  sub-component stays inside the VEVENT block (it carries no
  DTSTART, so no collision); only the sibling `VTIMEZONE` is
  excluded.
- `packages/calendar/test/calendar.test.ts` — a new `it` in the
  `CalDAVCalendarProvider ICS time parsing` describe: a realistic
  VCALENDAR with a full `VTIMEZONE` (STANDARD + DAYLIGHT,
  DST-rule DTSTARTs) **before** the VEVENT; asserts the event
  resolves to its real `2026-05-17T14:00:00.000Z` start (10:00
  EDT), not the 2007 DAYLIGHT-rule date, and keeps the right
  uid/title.

## Verify

- New `it` green; full `@muse/calendar` suite 35 passed (3
  files, +1); tsc strict (calendar) EXIT=0.
- **Mutation-proven teeth**: reverting to the whole-VCALENDAR
  parse makes the new test fail with exactly
  `AssertionError: expected '2007-03-10T17:00:00.000Z' to be
  '2026-05-17T14:00:00.000Z'` — the precise pre-fix corruption
  (the VTIMEZONE DST-rule date read as the event start); source
  then restored (suite back to 35 green).
- `pnpm check` EXIT=0, every workspace green (calendar 35,
  cli 739, api …) — no regression (the pre-existing
  no-VTIMEZONE TZID / Z / all-day tests still pass);
  `pnpm lint` 0/0; `pnpm guard:core` clean; byte-scan clean;
  `git status` shows only the two intended files.
- Pure deterministic ICS text parsing (faked `fetch` in the
  test) — no LLM / model request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-loop
  Step 9).

## Status

Done. A timezone-qualified CalDAV event is now parsed with its
own DTSTART/DTEND instead of a 2007-era VTIMEZONE DST-rule date,
so JARVIS's "what's next", calendar-imminence proactive notices,
and `muse today` show the correct time for the overwhelmingly
common real-world event shape. Floating / UTC-Z / all-day events
(no VTIMEZONE) are unchanged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a correctness `fix:` to an existing
core calendar-read path, recorded honestly with this backlog row
— not a false metric.

## Decisions

- Extracted the VEVENT body rather than skipping the VTIMEZONE
  span specifically: scoping to the component being parsed is the
  robust, general fix (also isolates any future preceding
  component), and it matches the one-event-per-`<response>`
  contract `parseCalendarQueryResponse` already assumes.
- Kept the whole-string fallback when no `BEGIN/END:VEVENT`
  delimiters are present: some minimal servers return a bare
  VEVENT body without the VCALENDAR wrapper; the fallback keeps
  those working (behaviour-identical for every input the old code
  parsed correctly).
- Found via a disciplined fresh-package survey (prompts /
  multi-agent / runtime-state were mature or fixed in prior
  iters); recorded that this is the concrete real-world defect,
  not a manufactured one.
