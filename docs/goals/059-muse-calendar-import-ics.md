# 059 — muse calendar import <file.ics>

## Why

Read an .ics file + create matching events in the local provider.
One-shot bulk import.

## Scope

- New subcommand under muse calendar.
- node-ical or hand-rolled parser.
- Idempotent via uid.

## Verify

- cli + calendar test.

## Status

open
