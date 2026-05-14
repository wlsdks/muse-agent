# 062 — muse history relative time in formatted output

## Why

Currently shows ISO. Render '2h ago', 'yesterday', '5d ago' when
recent; ISO for older entries.

## Scope

- Helper formatRelativeTime(iso, now).
- Apply in commands-history.ts formatted block.

## Verify

- cli +2 tests.

## Status

open
