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
