# 401 — Situational briefing grounded in real imminent calendar events (P8-b4, loop-extended)

## Why

Direct continuity: goal 400 delivered P8-b3 (briefing grounded in
real imminent personal tasks) and its `## Decisions` explicitly
recorded "calendar-derived imminence (vs personal tasks) is the
natural next enhancement and is deliberately NOT bundled". This
iteration ships that recorded follow-up as loop-extended **P8-b4**
so the briefing's "tells you what is coming up" is complete: tasks
AND calendar. `ServerOptions.calendar` (a `CalendarProviderRegistry`)
already exists, so the briefing daemon can union it cheaply.

## Slice

- `packages/mcp/src/briefing-imminent.ts` —
  `deriveCalendarBriefingImminent(lister, { now, leadMinutes })`,
  a pure adapter mirroring `runDueProactiveNotices`'s calendar
  imminence rule EXACTLY: skip all-day, skip an unparseable
  `startsAt`, must fall in `[now, now+lead]`, respect the
  `[no-proactive]` opt-out marker (title/notes). Duck-typed
  `lister` (`{from,to} → events[]`) so `@muse/mcp` stays
  calendar-package-free; fail-soft (throwing lister → `[]`).
- `apps/api/src/tick-daemons.ts` — the briefing daemon's
  `imminentProvider` now unions `deriveBriefingImminent(tasksFile)`
  + `deriveCalendarBriefingImminent(options.calendar.listEvents)`,
  whichever are configured (`composeSituationalBriefing` already
  sorts soonest-first, so union order is irrelevant).

## Verify

- `@muse/mcp` briefing-imminent.test.ts 4/4 (calendar: timed/
  in-window/non-opted-out selection vs all-day/NaN/past/far/
  `[no-proactive]`-title/`[no-proactive]`-notes; `[now,now+lead]`
  range passed to the lister; throwing lister → `[]`).
- `@muse/api` situational-briefing-tick.test.ts 5/5 incl.
  "P8-b4: a real imminent calendar event is grounded into the
  briefing's Upcoming, unioned with tasks" — drives the real tick
  with an imminentProvider unioning a seeded task + a fake
  calendar lister over a real `TelegramProvider` HTTP-fake;
  asserts `Upcoming:` names BOTH soonest-first (the 12:20 event
  before the 13:30 task) plus objective status.
- `@muse/mcp` 479, `@muse/api` 192; tsc strict clean (ran
  proactively); `pnpm check` green (apps/cli 683, all packages);
  `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched — deterministic adapter +
  HTTP-faked delivery; no smoke:live applies.

## Status

P8-b4 done. The situational-briefing daemon now grounds its
`Upcoming:` in the user's real imminent **calendar events** as
well as tasks, unioned and soonest-first — "what is coming up" is
complete. P8 extended `b1, b2, b3, b4`; P8-b4 flipped `[x]`
(— 401); one CAPABILITIES line appended; README backlog row added.

## Decisions

- Loop-extended P8 with b4 (a NEW bullet, not a re-scope of the
  delivered b3): a delivered `[x]` bullet is never re-opened to
  absorb new scope; a new flippable bullet for the new calendar
  capability keeps the ledger honest. Recorded here per the
  bullet-extension requirement.
- `deriveCalendarBriefingImminent` mirrors the proactive calendar
  rule verbatim (incl. the `[no-proactive]` opt-out) so the
  briefing and the proactive daemon never disagree on "what is
  imminent" — no new calendar semantics invented.
- Duck-typed `lister` (not a `@muse/calendar` import): `@muse/mcp`
  must not depend on the calendar package; the apps/api daemon
  adapts `ServerOptions.calendar.listEvents` at the call site
  (same no-coupling discipline used throughout).
- `feat(api)`: a new production behaviour (the briefing now
  includes real upcoming calendar events), spanning the @muse/mcp
  adapter + the apps/api daemon union.
