# 220 — followup `at 15pm` must be rejected, not silently rolled to 3 AM

## Why

`extractFollowupPromises` (`followup-detector.ts`) powers the
JARVIS "you said you'd do X — here's the nudge" capability. Its
`at HH(:MM)? (am|pm)?` branch validates `hourRaw` only against
`0..23`, then calls `applyMeridiem(hourRaw, meridiem)`:

```ts
if (meridiem === "pm") return hour === 12 ? 12 : hour + 12;
```

With an explicit am/pm the hour is a **12-hour-clock** value,
but `hourRaw 13..23` (e.g. `"at 15pm"`, `"at 13pm"`) passes the
`0..23` check, and `applyMeridiem` returns `15 + 12 = 27` —
**no upper bound, not `undefined`**. The caller doesn't
re-validate, so `nextOccurrenceAtHourMinute` does
`candidate.setHours(27, …)`, and JS `Date.setHours(27)`
**silently rolls over** to ~3 AM the *next day*. So
`"remind me at 15pm"` schedules a followup at 03:00 tomorrow
instead of rejecting the contradictory input — the
anticipatory feature fires at a wrong, surprising time with
no signal. `"at 0am"` had the analogous problem (`0` is not a
valid 12-hour value).

## Scope

- `packages/agent-core/src/followup-detector.ts`: in
  `applyMeridiem`, when a meridiem is present require
  `1 <= hour <= 12` (a real 12-hour-clock value) and return
  `undefined` otherwise. The caller already does
  `if (hour24 === undefined) continue;`, so a contradictory
  `at 15pm` / `at 0am` / `at 13pm` now produces **no** bogus
  followup. The no-meridiem branch (bare 24-hour `at 20`,
  already range-checked `0..23` by the caller) is untouched,
  and every valid 12-hour input (`3pm→15`, `6am→6`, `12pm→12`,
  `12am→0`) is unchanged.
- `packages/agent-core/test/followup-detector.test.ts`: new
  regression — `at 15pm` / `at 0am` / `at 13pm` yield no
  `today-at` followup, while bare `at 20` still schedules
  20:00 (24h path preserved). Existing 12h conversion tests
  unchanged.

## Verify

- `pnpm --filter @muse/agent-core test` — 524 pass (1 new;
  existing `at 3pm`/`6am`/`12pm`/`12am` unaffected → no
  regression).
- `pnpm check` exit 0; `pnpm lint` exit 0.
- Pure deterministic text→Date parser — no model invoked; the
  unit test asserts the exact scheduling outcome
  (authoritative per the testing rules), same stance as the
  deterministic-parser goals 194/210/214/215. No smoke:live
  needed.

## Status

done — a 12-hour-clock contradiction in a followup promise is
rejected instead of silently scheduling the nudge at the
wrong time the next day; valid 12h and bare 24h inputs are
unchanged.
