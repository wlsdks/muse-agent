# 776 — feat: web-watch trigger detector (P21, slice 1)

## Why

A daily-driver JARVIS should "monitor this page and ping me when X" —
the flight price drops, the order ships, the seat opens. P18 already
perceives the user's live Chrome (read-only) and P2/P20 deliver
proactive notices; web-watch composes them. The core deterministic
piece is deciding, from two page-text snapshots, whether the watch
condition just became true — edge-triggered so a standing condition
doesn't re-ping every poll.

## Slice

`@muse/mcp` `detectWatchTrigger(previousText, currentText, rule)` —
pure, no deps. `WatchRule` supports:
- `appears` — fire when the term NEWLY contains (rising edge).
- `disappears` — fire when a term that WAS present goes away (needs a
  baseline).
- `onAnyChange` — fire on any content change vs the baseline.
- `caseInsensitive` (default true).

First observation (no `previousText`): `appears` fires if the term is
present now (the user learns it's there); `disappears` / `onAnyChange`
need a baseline and stay quiet.

## Verify

- `@muse/mcp` web-watch.test.ts (new, 7): `appears` fires on the
  rising edge / first-observation-if-present / not while persisting /
  not when absent; `disappears` needs a baseline; `onAnyChange` fires
  on change but never on first observation; a no-condition rule never
  fires; case-insensitive by default, opt-out works.
- **Mutation-proven**: dropping the `!presentBefore` rising-edge guard
  in `appears` makes a persisting term re-fire → the "not while it
  persists" test fails; restore → 7/7.
- Full `pnpm check` EXIT 0 (mcp 714, every workspace green); `pnpm
  lint` 0/0. Pure string logic — no model path → no `smoke:live`.

## Decisions

- **Edge-triggered, baseline-aware** — same posture as the ambient
  runner: notify once per transition, not every poll; first
  observation establishes the baseline (only `appears` fires on it,
  since "is it there?" is the user's question when they start
  watching).
- **Read-only watch, never acts** — a watch perceives + notifies; it
  NEVER submits/clicks (outbound-safety). P21's bullet stays `[ ]`;
  this is slice 1 (the detector). Slice 2 wires the polling tick
  (snapshot via the Chrome DevTools MCP read tool → `detectWatchTrigger`
  → proactive notice) and flips it.
