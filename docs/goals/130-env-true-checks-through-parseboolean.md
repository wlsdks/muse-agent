# 130 — Route inline env `=== "true"` checks through goal-128 `parseBoolean`

## Why

Goal 128 widened `autoconfigure.parseBoolean` to accept the
common admin spellings (`1` / `yes` / `on`) and fall back to the
caller's default on unknown input. Five sites still bypassed it
with the original strict `env.X?.trim().toLowerCase() === "true"`
form:

- `packages/autoconfigure/src/setup-status.ts` — Phase D agent
  surface (`MUSE_PROACTIVE_AGENT_TURN`, `MUSE_REMINDER_AGENT_TURN`).
- `apps/api/src/tick-daemons.ts` — pattern daemon
  (`MUSE_PROACTIVE_PATTERN_ENABLED`).
- `apps/api/src/server.ts` — Phase D activity-tracker wiring
  (same two `*_AGENT_TURN` flags).

A `MUSE_PROACTIVE_AGENT_TURN=1` produced `true` via the goal-128
parser but `false` via these inline checks — silent
configuration divergence depending on which surface the operator
hit first.

## Scope

- All five sites swapped to `parseBoolean(env.X, false)`.
- `setup-status.ts` imports from `./env-parsers.js` (sibling file
  in the same package).
- `tick-daemons.ts` + `server.ts` import from `@muse/autoconfigure`
  (already a workspace dep).
- No behaviour change for callers passing the literal `"true"` —
  this is purely additive across the alternative spellings.

## Verify

- `pnpm check` exit 0 (every workspace test still passes, including
  the goal-128 parseBoolean assertions).
- `pnpm lint` exit 0.
- `pnpm smoke:live` — 13/0 (server.ts wires phase-D flags on
  startup; live round-trip confirms the swap doesn't flip
  defaults).

## Status

done — every `MUSE_*` boolean flag now reads through one parser.
Future audits of "is this flag on?" walk one helper instead of
five inline forms.
