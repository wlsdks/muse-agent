# 744 — fix: macOS calendar all-day events read back as all-day, not timed

## Why

`MacOsCalendarProvider.listEvents` shells out to AppleScript and parses
a tab-delimited `id\tstart\tend\ttitle\tloc` line per event. The list
query never emitted the all-day flag, and `parseListOutput` hardcoded
`allDay: false` — so EVERY macOS calendar event came back as timed,
even ones the user created as all-day. Google and CalDAV both detect
all-day correctly (`start.date` / `VALUE=DATE`); macOS was the
outlier, and the inconsistency is user-visible: `muse calendar` /
`muse today` render an all-day event with spurious clock-time
semantics. The create path already sets `allday event: true`, so Muse
could WRITE an all-day macOS event but READ it back as timed.

## Slice

- List query (the AppleScript): append `(allday event of evt as string)`
  as a 6th tab field. `allday event` is the same Calendar.app property
  the create path already uses, so this is a consistent, low-risk
  property read — not a new AppleScript surface.
- `parseListOutput`: read the 6th field; `allDay = allDayRaw === "true"`.
  A missing 6th field (legacy output) reads as not-all-day, so the
  change is backward-compatible.

## Verify

- `@muse/calendar` calendar.test.ts (new): a fake-osascript binary
  emits a timed record (`…\tfalse`) and an all-day record (`…\ttrue`);
  `listEvents` returns `allDay:false` / `allDay:true` respectively, and
  the all-day event keeps its location. **Mutation-proven** — reverting
  the parser to `allDay: false` fails the all-day case.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0 (standalone). No model path —
  no `smoke:live`.

## Decisions

- **Parser fully verified; AppleScript emit not dog-food-able here** —
  the parse side is exercised end-to-end via a real fake-osascript
  binary (the harness the timeout tests already use). The one-token
  AppleScript addition reuses the create path's proven `allday event`
  property, so it carries minimal risk despite no macOS in CI.
- **6th field, backward-compatible default** — an absent flag reads as
  not-all-day, matching the prior behavior for any legacy/!macOS path.
