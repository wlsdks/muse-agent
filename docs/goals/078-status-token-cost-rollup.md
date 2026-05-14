# 078 — muse status surfaces today's token-cost rollup

## Why

Token usage sink writes per-run cost. Roll up day-by-day + show today's
total in muse status.

## Scope

- Read traceSink.queryCost(today).
- New 'cost' section in snapshot.

## Verify

- cli +1 test.

## Status

open
