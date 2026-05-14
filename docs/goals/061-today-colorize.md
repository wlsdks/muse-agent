# 061 — muse today colorize output (tty-aware)

## Why

Add ANSI colors for the day-of-week header + overdue markers when
stdout is a TTY. NO_COLOR env var respected.

## Scope

- chalk or a tiny helper.
- TTY detection.
- Snapshot test with TTY off.

## Verify

- cli +1 test.

## Status

open
