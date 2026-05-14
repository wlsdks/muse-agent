# 021 — `muse calendar tomorrow` / `this-week`

## Why

Currently `muse calendar` is a list-only surface. Useful quick subs:
`muse calendar tomorrow` filters to events between tomorrow 00:00
and 23:59; `muse calendar this-week` is now → end-of-week. Saves
typing date args.

## Scope

- New subcommands in `commands-calendar.ts`.
- Both call the same underlying list with computed `from` / `to`
  based on the local timezone.
- Honour `MUSE_TIMEZONE` env if set; otherwise system tz.

## Verify

- pnpm check / lint / smoke.
- cli +2 tests (tomorrow + this-week).

## Status

open

## Status

done — `muse calendar tomorrow` (next day 00:00 → 23:59 local)
and `muse calendar this-week` (now → end-of-Sunday 23:59 local)
both delegate to the same listEvents call as `events` with
computed from/to. cli +1 test asserts ev_tomorrow appears under
tomorrow but a 30-day-away event never makes this-week.
