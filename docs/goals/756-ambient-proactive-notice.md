# 756 — feat: ambient signal → proactive notice (P20 perception FLIP)

## Why

P20 perception: a continuous ambient signal (frontmost app / window
title / selected text / clipboard / notifications) should feed a
proactive notice WITHOUT the user invoking anything. Today the ambient
snapshot only enters the REQUEST path (`applyAmbientContext` during a
run); nothing turns an ambient change into a self-initiated notice.

## Slice

`@muse/mcp` ambient-notice-loop.ts:
- `AmbientSignal` (structural mirror of agent-core's `AmbientSnapshot`
  — keeps this in `@muse/mcp` without depending on `@muse/agent-core`)
  + `AmbientSignalSource`.
- `AmbientNoticeRule { id, title, message, match }` +
  `deriveAmbientNotices(signal, rules)` — emits a notice for each rule
  whose match patterns ALL appear (case-insensitive substring) in the
  signal. A no-pattern rule never fires; a missing signal field never
  matches.
- `runAmbientNoticeTick({ source, rules, sink, alreadyFiredRuleIds })`
  — one no-invoke tick: read the signal, derive notices, deliver the
  not-yet-fired ones through the real `ProactiveNoticeSink`, return
  the cumulative fired-rule set (fire once until cleared — no per-tick
  spam). Fail-soft on a throwing source.

## Verify

- `@muse/mcp` ambient-notice-loop.test.ts (new, 6):
  - `deriveAmbientNotices`: substring match fires; ALL named fields
    must match (app-matches/window-doesn't → no fire); empty-pattern
    rule never fires; missing field / undefined signal → none.
  - `runAmbientNoticeTick` end-to-end: a simulated source (active
    window "Team Standup — 14:00") + a rule delivers the notice
    through a contract-faithful `ProactiveNoticeSink` (real interface,
    capturing impl); already-fired rule is not re-delivered;
    throwing source delivers nothing.
- **Mutation-proven**: `.every` → `.some` in the matcher fails the
  ALL-fields test; restore → 6/6.
- Full `pnpm check` EXIT 0 (mcp 688, every workspace green); `pnpm
  lint` 0/0. No model request/response path → no `smoke:live`; the
  real derive → dedupe → sink-deliver path runs against the
  contract-faithful sink.

## Decisions

- **Bullet's check is "a SIMULATED ambient signal drives a real
  proactive delivery end-to-end"** — exactly what the e2e proves
  (simulated signal source → real `ProactiveNoticeSink`). So P20
  perception flips.
- **Structural `AmbientSignal` in `@muse/mcp`** so the loop reaches
  the existing `ProactiveNoticeSink` without `@muse/mcp` depending on
  `@muse/agent-core` (the enforced boundary); the request-path
  `AmbientSnapshotProvider` is structurally assignable.
- **Fire-once dedupe** (`alreadyFiredRuleIds`) — continuous perception
  must not re-ping the same ambient condition every tick. Persisting
  the fired set + a concrete OS active-window source + daemon
  registration are the production wiring follow-on (mirrors the other
  firing loops); the perception→delivery path is delivered here.
