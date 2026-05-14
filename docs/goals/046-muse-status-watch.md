# 046 — muse status --watch (revive deferred 020)

## Why

Live-refresh muse status. Default 5s tick; --interval override; clean
Ctrl-C exit.

## Scope

- --watch flag + interval loop.
- Reuse collectStatus + formatted renderer.
- Clear screen between renders (ANSI clear).

## Verify

- cli +1 test (multi-render assertion).
- Manual dogfood verifies refresh.

## Status

open
