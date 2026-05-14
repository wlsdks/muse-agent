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

done — `muse status` snapshot gains a `cost` section sourced
from an optional sidecar JSON
(`~/.muse/token-cost-today.json`, overridable via
`MUSE_TOKEN_COST_TODAY_FILE`). Shape: `{ totalUsd?,
totalTokens?, runs?, asOfIso? }` — every field optional so a
partial / forward-compatible writer still renders.

Renderer prints `cost (today): $<usd>, <tokens> tokens over
<runs> run(s)` + `as of: <iso>` when the file is present;
silent otherwise so a fresh install doesn't show a useless
line.

Scope deviation: this goal originally said "Read
traceSink.queryCost(today)". Direct in-process query would
have coupled the local-first `muse status` to the API server.
The sidecar contract decouples reader from writer — `muse
metrics show --json | jq` (goal 077) or a future
observability cron can write the file, and `muse status`
reads it without an extra round-trip. The cli is additive
only; `schemaVersion` doesn't bump.

cli +1 test exercises `readTokenCostToday` (missing /
present) + an end-to-end `muse status` invocation that
asserts the rendered line.
