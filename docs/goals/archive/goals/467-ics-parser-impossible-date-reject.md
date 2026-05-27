# 467 — `parseIcsDateValue` rejects an impossible calendar date instead of silent rollover (440 sibling)

## Why

`parseIcsDateValue` (`apps/cli` `ics-parser.ts`) parses the
`DTSTART` / `DTEND` of every event imported by `muse calendar
import` (via `parseIcsEvents` → `finalizeEvent`). For a
well-formatted but **impossible** date it built the Date with
`new Date(Date.UTC(year, month-1, day, …))` and returned it
**unvalidated**. `Date.UTC` silently rolls over: a
`DTSTART;VALUE=DATE:20260230` (Feb 30 — a typo'd / buggy-exporter
`.ics`) becomes `Date.UTC(2026, 1, 30)` → **2026-03-02**, and
`DTSTART:20260118T250000Z` (hour 25) / `:20260118T006099Z`
(min 60 / sec 99) roll into adjacent days/minutes. The event is
then imported **on the wrong day/time** with no error —
`finalizeEvent`'s `if (!startsAt) return undefined` only catches
a falsy return, not a (truthy) rolled-over Date.

This is the exact goal-440 silent-calendar-rollover class (440
fixed `parseTaskDueAt`: `2026-02-30` no longer scheduled as
Mar 2). `parseIcsDateValue` is the unfixed ICS-import sibling
using the same unguarded `Date.UTC` pattern. Found by following
the `Math.min(...startsAtMs)` / `startsAt.toISOString()` chain in
`commands-calendar.ts` back to the parser. Concrete and reachable
(malformed `.ics` from a typo or a buggy calendar exporter is
common); the codebase's own standing 440 decision; fresh package
(`ics-parser.ts` never touched; not the recently-churned
mcp/messaging). The existing `parseIcsEvents` tests cover
timed / all-day / unfold / skip-ill-formatted / unescape but
**no impossible-but-well-formatted date** — genuinely uncovered,
and they stay green (no wrong premise).

## Slice

- `apps/cli/src/ics-parser.ts` — both `parseIcsDateValue`
  branches (8-digit `VALUE=DATE`, and the
  `YYYYMMDDThhmmss(Z?)` timed form) now validate the `Date.UTC`
  round-trip (mirroring goal 440's `parseTaskDueAt`): if the
  constructed Date's UTC components don't equal the parsed
  Y/M/D(/h/m/s), `return undefined`. `finalizeEvent` already
  drops a `undefined` DTSTART, so an impossible date now causes
  the event to be **skipped** — consistent with the parser's
  documented "skips malformed entries silently" contract.
  Behaviour byte-identical for every real date (round-trip
  matches → same Date returned).
- `apps/cli/src/ics-parser.test.ts` — a new `it`: Feb 30 /
  month-13 / hour-25 / min-60 / sec-99 (both DATE and timed
  forms) → `parseIcsEvents` returns `[]`; a genuine leap day
  (`20280229`) and an ordinary `20261231T235959Z` still parse
  unchanged (no regression).

## Verify

- New `it` green; the pre-existing `parseIcsEvents` tests still
  green (no wrong premise); full `@muse/cli` suite green (69
  files, +1 it, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the DATE-form
  round-trip guard makes the new test fail with
  `expected [ { title: 'Bad', … } ] to deeply equal []` — i.e.
  `DTSTART;VALUE=DATE:20260230` is silently imported (as the
  rolled-over Mar 2) instead of skipped; fix restored, suite
  back to green.
- `pnpm check` EXIT=0, every workspace green (cli, api …) — no
  regression; `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure deterministic ICS date parsing — no LLM / model
  request-response wire path; `smoke:live` does not apply (per
  `testing.md` / iteration-loop Step 9).

## Status

Done. A malformed `.ics` with an impossible date no longer
imports a calendar event on the wrong day/time via `muse calendar
import` — the impossible date is rejected and the event skipped,
exactly as the parser already treats other malformed entries. The
440 impossible-calendar-date standard now covers the ICS-import
sibling. Every valid date (incl. leap days) is unaffected.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]` and audited; a 440 sibling-asymmetry correctness
`fix:`, recorded honestly with this backlog row — not a false
metric.

## Decisions

- Validated BOTH the DATE and timed branches (incl. h/m/s for
  the timed form): an out-of-range hour/minute/second rolls just
  like an out-of-range day and would equally mis-time the
  imported event; the round-trip check is the canonical
  per-component validation (byte-parallel to 440).
- Skip (return undefined → event dropped) rather than throw or
  clamp: `parseIcsEvents`'s documented contract is "skips
  malformed entries silently … on the real clock"; an
  impossible date is a malformed entry, and dropping it is
  strictly consistent with the existing ill-formatted-→-undefined
  path (a leap-second `:60` is likewise dropped — far better than
  a silently-wrong time).
- Confirmed (not assumed) the parser never yielded an *Invalid
  Date* object (it returns `undefined` for ill-formatted input),
  so the `commands-calendar.ts` `Math.min`/`toISOString` chain
  was not the defect — the silent *rollover* is; recorded that
  ruled-out hypothesis transparently.
