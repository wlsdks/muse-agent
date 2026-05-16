# 248 — one Invalid-Date calendar event crashed the whole proactive tick

## Why

The proactive daemon (`runDueProactiveNotices`, Phase A/B — the
flagship anticipatory JARVIS feature) had an asymmetry between its
two signal sources:

- **Task path** guards a bad date:
  ```ts
  const dueAt = new Date(task.dueAt);
  if (Number.isNaN(dueAt.getTime())) continue;
  ```
- **Calendar path** did not:
  ```ts
  if (event.allDay) continue;
  if (event.startsAt < nowDate || event.startsAt > cutoff) continue;
  ```

`CalendarEvent.startsAt` is a `Date`, and `LocalCalendarProvider`
builds it as `new Date(<string from ~/.muse/calendar.json>)`. A
hand-edited or malformed `calendar.json` (or a flaky CalDAV / ICS
feed) yields an **Invalid Date**. Every relational comparison
with `NaN` is `false`, so `event.startsAt < nowDate` and
`event.startsAt > cutoff` are both false — the bad event is **not**
filtered. It lands in `imminent[]`, and the per-item loop then
calls `item.startsAt.toISOString()`, which throws
`RangeError: Invalid time value`.

That throw is outside the per-item try/catch (which only wraps the
messaging send), so it rejects the entire
`runDueProactiveNotices` promise. Net effect: a **single**
corrupt event silently kills proactive notices for that whole
tick — including every valid imminent event queued after it.
Because the corrupt event stays in the calendar, this repeats
every tick: JARVIS goes permanently silent until the bad event is
removed, with no notice to the user.

## Scope

`packages/mcp/src/proactive-notice-loop.ts` — one guard added to
the calendar loop, immediately after the all-day check and before
the range check, exactly mirroring the task path:

```ts
if (Number.isNaN(event.startsAt.getTime())) continue;
```

A malformed event is now skipped silently (consistent with the
task path's `continue` on a bad `dueAt` — a corrupt entry is not
a delivery error, so `errors` stays clean) and every valid
imminent item in the same tick is still delivered.

## Verify

- `pnpm --filter @muse/mcp test` — 340 pass (was 339; +1). New
  regression test feeds a calendar registry whose FIRST event has
  `startsAt: new Date("not-a-date")` and whose second is a valid
  imminent "Standup"; asserts the call does not throw,
  `{ fired: 1, imminent: 1, errors: [] }`, and the Standup notice
  is delivered (pre-fix the loop threw on the first event and the
  Standup was lost).
- `pnpm check` — every workspace green (mcp 340, apps/cli 555,
  apps/api 155, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (pure date guard in
  the calendar-event filter; Phase D synthesis path unchanged), so
  no Qwen round-trip applies.

## Status

done — a corrupt / hand-edited calendar entry can no longer crash
the proactive tick. The calendar path now validates `startsAt`
the same way the task path validates `dueAt`, so one bad event is
skipped instead of silencing the entire anticipatory feature every
tick.
