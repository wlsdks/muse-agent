# 025 — `muse today` shows pattern-detector suggestions

## Why

`muse today` covers tasks / events / notes / reminders / followups
but not detected patterns. The pattern detector publishes
suggestions (`muse pattern list`) — surfacing the top 1-2 in the
morning brief gives the user "JARVIS noticed you usually walk
between 07:30 and 08:00" without an extra command.

## Scope

- Extend `TodayBriefing` with `patterns?: { suggestion, confidence }[]`.
- Compose path: read patterns-fired sidecar + run detector on demand
  (rate-limited so today doesn't trigger heavy work).
- `formatPatterns` block in `muse today` output between reminders
  and tasks.

## Verify

- pnpm check / lint / smoke.
- cli +1 test (seeded pattern → rendered).

## Status

open
