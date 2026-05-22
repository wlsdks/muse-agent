# 717 — fix: quiet-hours config accepts `HH:MM`, so `22:00-07:00` no longer silently turns quiet hours OFF

## Why

`parseQuietHours` (apps/api/src/reminder-tick.ts) gates SIX proactive
daemons (reminder, proactive, pattern, situational-briefing, objectives,
followup — all via `MUSE_*_QUIET_HOURS`). It matched only the bare-hour
form `^(\d{1,2})-(\d{1,2})$`, so the entirely natural `22:00-07:00`
failed the regex → returned `undefined` → quiet hours OFF with no
warning. A user who set `MUSE_REMINDER_QUIET_HOURS=22:00-07:00` to stop
3am pings would still get them. Silent-disable on a plausible input is a
real trust footgun for a personal assistant.

Rotated surface (PROCEDURE Step 8: recent iterations churned
actuator/channel/setup/vision/model; this is the proactive/reminders
config layer).

## Slice

- `apps/api/src/reminder-tick.ts`: widen the `parseQuietHours` regex to
  `^(\d{1,2})(?::(\d{2}))?-(\d{1,2})(?::(\d{2}))?$`, validate optional
  minutes (0–59), and use the hour (the window stays hour-granular —
  minutes are validated then rounded down, so `22:30` → hour 22). Bare
  `22-7` still works; `22:00-07:00` now works; out-of-range minutes
  (`22:60`) and single-digit minutes (`22:5`) are rejected (return
  `undefined`) rather than misparsed.
- `docs/design/reminder-firing.md`: note the accepted `HH:MM` form +
  hour-granular rounding.

## Verify

- `@muse/api` reminder-tick.test.ts (293 tests): parseQuietHours accepts
  `22:00-07:00`, `23:30-06:15`, `9:05-17:45`; rejects `22:60-07:00` and
  `22:5-7`; same-hour `22:00-22:30` → undefined (ambiguous under
  hour-granular windows); the existing bare-hour + out-of-range cases
  still pass.
- **Mutation-proven**: reverting to the hour-only regex fails the new
  HH:MM cases (and the bare-hour cases that share the validation path).
  Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — pure config parsing; the
  hour-granular `isQuietHour` eval and all seven callers are unchanged.

## Decisions

- **Hour-granular, minutes rounded down — not full minute precision** —
  `isQuietHour` and its seven daemon callers (`now().getHours()`) are
  hour-based; making the window minute-precise would touch all of them
  and their tests for marginal benefit. The footgun is the *silent
  rejection*, not the lack of minute precision, so the minimal fix is to
  accept the input and round, keeping the eval untouched.
- **Reject bad minutes rather than ignore them** — `22:60` is a typo;
  returning `undefined` (quiet hours off) is the documented
  malformed-input fallback, and a two-digit-minute requirement keeps the
  grammar unambiguous.
