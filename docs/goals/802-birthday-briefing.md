# 802 — feat: upcoming birthdays in the morning brief (completes 798)

## Why

798 stored contact birthdays + the on-demand `muse contacts
birthdays`. The daily-driver completion is PROACTIVE: the morning
brief should say "🎂 Sarah tomorrow" unasked, like a JARVIS that knows
your people. Composes 798's `resolveUpcomingBirthdays` engine into the
situational briefing exactly as home-alerts (791) did. (Redirect off
the 3-in-a-row tool-param-description area per the stagnation guard.)

## Slice

- `@muse/mcp` personal-contacts-store.ts — `formatBirthdayBriefLine(
  upcoming)` → "Sarah today; Bob tomorrow; Ann in 3 days", or
  `undefined` when none (brief stays quiet).
- situational-briefing.ts — optional `birthdays` line (supplementary,
  same posture as weather/inbox/home: rides a non-empty brief, never
  triggers one).
- situational-briefing-loop.ts — `birthdayLine?` resolver, sensed only
  when the brief has content; fail-soft (reused the generic
  `resolveLineSafely`, renamed from `resolveHomeAlertSafely`).
- `apps/api` — tick pass-through + daemon binds `birthdayLine` from the
  contacts file via `resolveUpcomingBirthdays` (`MUSE_BRIEFING_BIRTHDAY_DAYS`,
  default 7); returns undefined when none, so it's always wired but
  silent without upcoming birthdays.

## Verify

- `@muse/mcp` birthday-briefing.test.ts (new, 3): `formatBirthdayBriefLine`
  renders today/tomorrow/in-N-days soonest-first and returns `undefined`
  when none; **end-to-end** — `runDueSituationalBriefing` with the
  resolver delivers, through a real `MessagingProviderRegistry`, a brief
  whose `Birthdays: Sarah tomorrow` line rides alongside the imminent
  Standup.
- **Mutation-proven**: removing the empty-array guard in
  `formatBirthdayBriefLine` → it returns `""` not `undefined` → the
  none-case test fails; restore → 3/3. `pnpm lint` 0/0; full `pnpm
  check` exit 0 **on retry** — 3 pre-existing `mcp.test.ts` stdio-MCP /
  osascript SUBPROCESS-SPAWN tests fail intermittently in this sandbox
  (confirmed identical with my changes stashed → not this diff); my
  birthday/briefing tests pass 7/7. No model path → no `smoke:live`.

## Decisions

- **Always-wired, silent-when-none** — birthdays need only the contacts
  file (always resolvable) and the resolver returns `undefined` when no
  birthday is within the window, so no extra enable-gate; `withinDays`
  is env-tunable (default 7).
- No bullet flip — completes 798 into the proactive brief (P20/P8).
  CAPABILITIES line under P20.
