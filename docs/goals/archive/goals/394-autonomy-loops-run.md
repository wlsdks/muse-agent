# 394 — The delegated-autonomy loops actually RUN (P9-b1) — loop-authored

## Why

P0–P8 are all delivered + audited. Per the OUTWARD-TARGETS
contract the loop self-extends the map. The chosen direction also
honours this iteration's explicit steer ("prefer deepening and
polishing what exists over piling on new surface"): a survey found
`runDueProactiveNotices` / `runDueFollowups` are wired into apps/api
`setInterval` ticks, but **`runDueObjectives` (P5-b2) and
`runDueSituationalBriefing` (P8-b2) have NO apps/api daemon** — the
user's running server never drives them. The delegated-objective
autonomy and the proactive briefing therefore exist only as tested
libraries; a JARVIS does these continuously, unasked. P9 closes
that pure-productionisation gap. (It also discharges the standing
deferred ledger note about the loops not being daemon-wired.)

## Slices

- s1 (P9-b1, THIS): `apps/api/src/objectives-tick.ts` —
  `startObjectivesTick`, a `setInterval` rider mirroring
  `followup-tick.ts` / `proactive-tick.ts` exactly: clamped
  cadence [5s,1h], single-flight `firing` guard, fail-soft
  per-tick try/catch, `unref`, `tickOnce`/`stop` handle,
  quiet-hours parity. Transport-agnostic — `evaluate` / `act` /
  `escalate` injected like followup-tick injects
  `modelProvider`/`registry`. Verified by
  `apps/api/test/objectives-tick.test.ts`.
- s2 (P9-b2, next): env-gate + register the objectives AND the
  situational-briefing daemons in the apps/api daemon set
  (`startObjectivesDaemonIfConfigured` parallel to
  `startFollowupDaemonIfConfigured`), off by default, with the
  concrete production evaluator/actuator wired.

## Verify

- `apps/api/test/objectives-tick.test.ts` 4/4 (run directly) and
  within `pnpm --filter @muse/api test` (176 pass); tsc strict
  clean (ran proactively).
- `pnpm check` green across all workspaces (apps/cli 683, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean (P9 added
  outside IMMUTABLE-CORE).
- No request/response (LLM) path touched — the rider drives the
  already-tested `runDueObjectives` with injected evaluate/act;
  the bullet's mandated check is the daemon-discipline
  integration. No smoke:live applies.

## Status

P9-b1 done. The bullet's check is delivered: a tick handle fires
`runDueObjectives` on a due objective (act called, objective
durably `done`); a concurrent `tickOnce` while one is in-flight
does NOT double-fire (single-flight `firing` guard — exactly one
evaluation); a throwing evaluator is fail-soft (error logged, the
rider survives, a subsequent tick succeeds); a
`Number.POSITIVE_INFINITY` interval is clamped and still yields a
working, stoppable rider. P9-b1 flipped `[ ]`→`[x]`; one
CAPABILITIES line appended; README backlog row added.

P9-b2 stays `[ ]` (separate bullet, separate slice).

## Decisions

- This flips P9-b1 on the daemon-rider integration — the same
  shape `followup-tick.ts` is the deliverable for its capability
  (tick-daemons.ts merely env-starts it). The rider IS the
  production autonomy mechanism; env-gated registration + the
  concrete evaluator/actuator is P9-b2.
- The rider is transport-agnostic (`evaluate`/`act`/`escalate`
  injected) deliberately: a real condition-evaluator/actuator does
  not yet exist (runDueObjectives' evaluate/act were always
  injected) and building one is P9-b2's scope — baking a half one
  in here would be speculative. The daemon discipline (clamp /
  single-flight / fail-soft / unref) is the load-bearing,
  testable-now part and is delivered complete.
- Chosen over a brand-new 10th capability epic because the prompt
  steered toward deepening what exists AND the loops-not-running
  gap is genuinely more outward (a thing the user's server now
  does) than another library — and it resolves a standing
  deferred concern rather than adding a new one.
- `feat(api)`: a new production behaviour (the server autonomously
  re-evaluates standing objectives), mirroring the followup /
  proactive daemon riders.
