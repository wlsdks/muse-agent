# 791 — feat: situational briefing flags noteworthy home states (compose 783 → P8/P20)

## Why

783 gave Muse the ability to READ Home Assistant state, but only on
demand. The morning/situational briefing already composes weather +
inbox + upcoming + related-knowledge; a daily-driver JARVIS should ALSO
proactively flag a home-security state that's noteworthy — "you're
heading out and the front door is unlocked" — without being asked.
Composes 783 (HA read) into the proactive briefing surface.

## Slice

- `@muse/mcp` smart-home.ts — `resolveHomeAlertLine(connection,
  checks)` reads each configured entity and surfaces ONLY the ones in
  a noteworthy state ("Front door is unlocked; Garage is open");
  returns `undefined` when everything is safe (never narrates
  "normal"); a per-entity read failure is skipped, not thrown.
  `HomeAlertCheck = { entityId, label, alertStates }`.
- situational-briefing.ts — optional `home` line, same supplementary
  posture as weather/inbox (rides a non-empty briefing, never triggers
  one).
- situational-briefing-loop.ts — `homeAlert?` resolver option, sensed
  only when the briefing already has content; fail-soft.
- `apps/api` situational-briefing-tick.ts — `homeAlert` pass-through so
  the daemon can drive it.

## Verify

- `@muse/mcp` home-alert-briefing.test.ts (new, 4, contract-faithful HA
  fake): `resolveHomeAlertLine` flags alert-state entities joined /
  returns `undefined` when all safe / skips a per-entity 404 and
  surfaces the rest; **end-to-end** — `runDueSituationalBriefing` with
  the resolver delivers, through a real `MessagingProviderRegistry`, a
  briefing whose `Home: Front door is unlocked` line rides alongside
  the imminent Standup item.
- **Mutation-proven**: forcing the alert-state match to always-true →
  the "undefined when everything safe" test fails (a locked door gets
  flagged); restore → 4/4. Existing briefing tests 11/11 (no
  regression). Full `pnpm check` EXIT 0, `pnpm lint` 0/0. No LLM
  request/response path → no `smoke:live`.

## Decisions

- **Only noteworthy states** — `alertStates` per check; a safe state
  yields no line so the briefing never narrates "everything's normal".
  This is what keeps it signal, not noise.
- **Supplementary, never a trigger** — like weather/inbox, the home
  line rides an otherwise-non-empty briefing and is only sensed when
  there's already something to say (no HA call on an empty tick).
- No bullet flip — composes P19 (783 hardened HA read) into P8/P20
  proactive briefing. The daemon env-wiring (HA creds + a JSON
  alert-checks config → bound `homeAlert`) is the production follow-on.
