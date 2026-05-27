# 405 — The objectives daemon's autonomous actions are P6-accountable

## Why

P6's load-bearing promise: "a reviewable action log records EVERY
autonomous action (what / why / when / result)." P9 then made the
objectives daemon act autonomously in a real running server
(notify on met, escalate on unmeetable / attempts-exhausted). But
a grep confirmed `createMessagingObjectiveActuator` and the
objectives daemon wiring never touched the P6 action log — so the
single most autonomous, unattended thing Muse does (acting on a
standing objective without the user present) was **invisible to
the accountability surface**. That is a real P6↔P9 composition
gap, in a deliberately different area from the recent
briefing / P7-prod / evaluator-parse / CLI iterations (Step-8
anti-concentration).

## Slice

- `packages/mcp/src/objective-evaluator.ts`:
  `MessagingObjectiveActuatorOptions` gains optional
  `actionLogFile?` + injectable `now?`. When set, `act` /
  `escalate` append a rationale-bearing `ActionLogEntry` AFTER a
  successful send: `what` = "objective met|escalated — user
  notified", `why` = the objective spec, `when`, `result` =
  `performed`, `objectiveId`, `detail` (HTTP-notice / escalation
  reason). **Fail-soft**: a log-append failure is swallowed — the
  notification already succeeded and the unattended daemon must
  never crash over a log write.
- Production wiring (the proven 396/402 mirror):
  `resolveActionLogFile` (`~/.muse/action-log.json`,
  `MUSE_ACTION_LOG_FILE` override) → `personal-providers` /
  `@muse/autoconfigure` index re-export → `api-server-options`
  populates `ServerOptions.actionLogFile` →
  `startObjectivesDaemonIfConfigured` passes it into
  `createMessagingObjectiveActuator`.

## Verify

- `@muse/mcp` objective-evaluator.test.ts 7/7: 5 prior
  (parse/robustness/model/actuator-delivery) UNCHANGED + pass,
  plus "when actionLogFile is set, each autonomous action is
  appended as a reviewable rationale-bearing entry" (queryActionLog
  returns both the met + escalated entries with the right
  what/why/result/objectiveId, escalate's detail = the reason) and
  "no actionLogFile ⇒ unchanged behaviour (delivery only)".
- Cross-package change (mcp actuator → autoconfigure resolver →
  apps/api), so `pnpm check` (dependency-order build+test) is the
  gate: green across all workspaces (apps/cli 691, @muse/mcp 485,
  @muse/api 192, all packages); `pnpm lint` 0/0;
  `pnpm guard:core` clean; tsc strict clean.
- No new request/response (LLM) round-trip — the actuator's send
  path is unchanged; the added step is a deterministic local
  action-log append. No smoke:live applies.

## Status

Done. A running server's objectives daemon now records every
autonomous objective action it takes into the reviewable P6
action log — `queryActionLog`/`muse actions` (future CLI) will
show "objective met — user notified" / "objective escalated — user
notified" with the objective spec as the rationale. The user can
finally audit what Muse did on their behalf while they were away.
One CAPABILITIES line appended citing P6-b1 (the accountability
bullet whose promise this extends to the P9 daemon). No
OUTWARD-TARGETS flip — P6-b1 and P9 were already `[x]`; this
composes them, recorded honestly as a new reviewable surface, not
a false metric.

## Decisions

- Fail-soft on the log append is the correct posture: P6
  accountability is best-effort RELATIVE to the just-delivered
  action (the notice already went out); crashing an unattended
  daemon because a log file is momentarily unwritable would be
  strictly worse than a missing audit line. The objective
  lifecycle (P5-b2) separately persists status, so the action is
  never lost — only its audit line could be, rarely.
- `actionLogFile` optional + the daemon wiring spreads it only
  when present → zero behaviour change for any caller that does
  not opt in; the existing actuator-delivery test still passes
  byte-for-byte.
- CAPABILITIES line citing P6-b1, no bullet flip: a genuine new
  user-reviewable surface (daemon actions in the audit log) but
  nothing in OUTWARD-TARGETS was unmet — recorded honestly, same
  discipline as goal 404.
- Different area (P6↔P9 accountability composition) from the prior
  iterations — Step-8 anti-concentration, and closing a
  P6-mandated gap is genuinely outward, not polish.
