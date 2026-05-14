# 020 — `muse status --watch`

## Why

`muse status` is a one-shot dashboard. The JARVIS-style ask is a
live-refresh view that polls the on-disk stores every N seconds
and re-renders. Useful during a busy day (proactive notice drops in,
followup fires).

## Scope

- `--watch` flag in `commands-status.ts`.
- Loop with default 5s interval (override via `--interval`).
- Reuses the existing `collectStatus` + formatted renderer.
- Clear screen between renders (ANSI clear — already safe because
  status output is fully internal).
- Ctrl-C exits cleanly.

## Verify

- pnpm check / lint.
- Manual dogfood: run, modify a store, see refresh.
- cli +1 test (assert two renders fire when iter > 1).

## Status

deferred
 — TUI loop mode + interval option + clean Ctrl-C handling.
Bigger scope than fits this batch; better as its own iter that
also wires through a stable terminal-clear sequence.
