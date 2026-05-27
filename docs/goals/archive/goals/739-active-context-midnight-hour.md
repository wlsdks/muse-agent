# 739 — fix: active-context `localHour` / working-hours treat midnight as 0, not 24

## Why

`formatCurrentTime` (packages/agent-core/src/time-helpers.ts) formatted
the local hour with `Intl.DateTimeFormat(..., { hour12: false })`. In
en-US that selects the **h24** hour cycle, which renders midnight as
`"24"`, so `localHour = Number.parseInt("24") = 24` — never 0.

`localHour` feeds `isWorkingHours`, which the ActiveContextProvider uses
to tell the agent whether the user is currently in working/active
hours. The 24-vs-0 error mis-classifies the midnight hour for any
window that starts at hour 0:

```ts
isWorkingHours(midnight, { start: 0, end: 8 })  // expected true
// localHour 24 → 24 >= 0 && 24 < 8 → false  (WRONG)
```

So a user whose active hours begin at midnight ("0-8", "0-9") would
have 00:00–00:59 reported as OUTSIDE working hours, and any consumer
reading `localHour` directly gets 24 (out of the 0–23 range) at
midnight. Same root cause as goal 735 (scheduler `dateParts`), a
different file the earlier fix didn't touch.

## Slice

`formatCurrentTime`: replace `hour12: false` with `hourCycle: "h23"`
(0–23) so midnight is `0`. No other behavior changes.

## Verify

- `@muse/agent-core` time-helpers.test.ts — new cases: `formatCurrentTime`
  reports `localHour: 0` at UTC midnight and at Asia/Seoul local
  midnight (15:00Z); `isWorkingHours(midnight, { start: 0, end: 8 })`
  is `true`. **Mutation-proven** — restoring `hour12: false` fails both
  (localHour 24).
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). Deterministic
  time logic — no model path, no `smoke:live`.

## Decisions

- **`hourCycle: "h23"`, mirroring 735** — the formatter option is the
  root cause; expressing the 0–23 clock is correct for every locale and
  is the same fix already proven in the scheduler.
- Swept the repo for the same `hour12: false` pattern; the only other
  hits already use it where `parseInt` of "24" is harmless or are
  display-only — this `localHour` path is the one with arithmetic
  consequences.
