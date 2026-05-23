## 834 — feat: the morning brief tells you the shape of your day

## Why

The situational brief listed imminent items, weather, inbox, home,
birthdays, due tasks — but never the SHAPE of the day: "am I slammed or
do I have room?" A JARVIS brief should say "free after 16:00" or
"booked solid the rest of today" so you know your runway at a glance.
The free/busy engine (827 `computeAvailability`) and a calendar source
were already in the briefing daemon — this composes them into a
supplementary brief line.

## Slice

- `@muse/mcp` situational-briefing.ts — pure `resolveDayShapeLine(events,
  {now, dayEndHour=22})` composing `computeAvailability` over `now →
  dayEnd`: `undefined` when there are no commitments left (rides
  nothing) or now is past the day-end hour; "booked solid the rest of
  today" when no gap remains; else "free <gaps>", a gap reaching day-end
  rendered "after HH:MM". `SituationalBriefingInput.availability` + a
  `Schedule:` render line (same supplementary posture as the others:
  rides a non-empty brief, never triggers one).
- `@muse/mcp` situational-briefing-loop.ts — `availabilityLine?`
  resolver, gated on `hasContent`, resolved via the existing
  `resolveLineSafely` (fail-soft).
- `apps/api` situational-briefing-tick.ts + tick-daemons.ts — wire
  `availabilityLine` to the briefing's calendar source (today's events
  → `resolveDayShapeLine`), so it ships when a calendar is configured
  (user-reachable, not a dangling helper).

## Verify

`@muse/mcp` day-shape-briefing.test.ts (6):
- `resolveDayShapeLine`: free gaps with a trailing "after 15:00"; "booked
  solid" when no gap; `undefined` with no commitments; `undefined` once
  past the day-end hour.
- **End-to-end** through the REAL `runDueSituationalBriefing` + a
  capturing messaging provider: a non-empty brief gains a "Schedule:
  free 09:00–10:00 …" line; the day-shape line ALONE (no imminent / no
  objective) delivers NOTHING (rides, never triggers).
- **Mutation-proven**: dropping the no-commitments→undefined guard makes
  the "rides nothing" test fail; never rendering "after" makes the
  free-gaps test fail. Full `pnpm check` EXIT 0, `pnpm lint` 0/0. A
  proactive brief, not a model tool → no smoke:live.

## Decisions

- **Undefined when no commitments** — a brief that's already firing for
  other reasons shouldn't add "free all day" noise; the line only earns
  its place when there ARE events to summarise the gaps around.
- **`after HH:MM` for the trailing gap** — "free after 16:00" is the
  signal a person wants; rendering "16:00–22:00" leaks the arbitrary
  day-end hour. CAPABILITIES line under P20 Perception / proactive brief
  (no bullet flip — deepens the existing briefing capability).
