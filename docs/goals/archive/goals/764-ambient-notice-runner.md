# 764 — feat: edge-triggered ambient notice runner (P20 perception, continuous dedup)

## Why

A CONTINUOUS perception daemon needs the right dedupe. `runAmbientNoticeTick`'s
`alreadyFiredRuleIds` is fire-once: persisted, it would NEVER re-notify
a recurring context (tomorrow's standup window); in-memory, it re-spams
every tick while the condition holds. Neither is correct for a
long-running tick. The correct semantics are EDGE-TRIGGERED: notify
when a condition first appears, stay quiet while it persists, and
re-arm once it clears.

## Slice

`@muse/mcp` `createAmbientNoticeRunner({ source, rules, sink })` — a
stateful runner whose `tick()`:
- reads the ambient signal (fail-soft on a throwing source),
- derives matched rules,
- delivers ONLY rules on the rising edge (matched now, not matched the
  previous tick) through the `ProactiveNoticeSink`,
- updates the matched-set so a rule that stops matching re-arms.

This is the daemon-appropriate runner; the trivial setInterval wrapper
(apps/api) is the remaining follow-on.

## Verify

- `@muse/mcp` ambient-notice-runner.test.ts (new, 2): with a mutable
  source — window→Standup fires (rising edge); still Standup → 0
  (steady state, no spam); window→Spotify → 0 (clears, re-arms);
  window→Standup again → fires again (2 total). Fail-soft: a throwing
  source delivers nothing.
- **Mutation-proven**: removing the rising-edge guard makes the
  steady-state tick re-fire → the test fails; restore → 2/2.
- Full `pnpm check` EXIT 0 (mcp 700, every workspace green); `pnpm
  lint` 0/0. Pure stateful logic + contract-faithful sink, no model
  path → no `smoke:live`.

## Decisions

- **Edge-triggered, in-memory state** — the correct continuous-
  perception dedupe (notify once per appearance, re-notify on
  recurrence). No file persistence: a restart re-arms (re-notifies the
  currently-active context once), which is the right default — better
  than a persisted set that goes permanently silent.
- No bullet flip — P20 perception is already `[x]` (756); this is the
  continuous-dedupe deepening + the runner the daemon will schedule
  (CAPABILITIES line). The apps/api setInterval daemon (env-gated,
  wiring `FileAmbientSignalSource` + `parseAmbientNoticeRules` + this
  runner) is the thin remaining follow-on.
