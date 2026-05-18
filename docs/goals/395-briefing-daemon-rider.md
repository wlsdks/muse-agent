# 395 — Situational-briefing daemon rider (P9-b2 split, child 1/2)

## Why

Continuity: goal 394 delivered P9-b1 (the objectives rider).
P9-b2 ("the objectives + situational-briefing daemons are
env-gated and started in the apps/api daemon set, with the
concrete production evaluator/actuator wired") genuinely bundles
three things: (a) the situational-briefing apps/api rider —
which, unlike the objectives rider, did not exist; (b) both
riders env-gated + registered in the daemon set
(`start…DaemonIfConfigured` + ServerOptions/autoconfigure
plumbing + server.ts); (c) a concrete production objectives
evaluator/actuator — generic "is this condition met?" is
agent/LLM, smoke:live-class. That is far too coarse for one tight
commit, so P9-b2 is **split**: parent stays `[ ]` until ALL
children are met (the 378-s2 / P5 precedent — no flipping a
trivially-met sub-bullet).

## Slices

- child 1/2 (THIS): `apps/api/src/situational-briefing-tick.ts` —
  `startSituationalBriefingTick`, the exact parallel of the P9-b1
  `objectives-tick.ts`: clamp [5s,6h] (a briefing is coarser than
  per-item ticks → 30 min default), single-flight `firing` guard,
  fail-soft per-tick try/catch, `unref`, `tickOnce`/`stop`,
  quiet-hours parity. Deterministic + zero-LLM: drives the pure
  `runDueSituationalBriefing` over the messaging registry.
  `imminent` defaults to `[]` so the daemon briefs delegated-
  objective status (calendar-derived imminent is a later
  injected enhancement). Verified by
  `apps/api/test/situational-briefing-tick.test.ts`.
- child 2/2 (next): both riders env-gated + registered in the
  apps/api daemon set + the concrete objectives
  evaluator/actuator. Flipping it flips parent P9-b2.

## Verify

- `apps/api/test/situational-briefing-tick.test.ts` 3/3 (run
  directly) and within `pnpm --filter @muse/api test` (179 pass);
  tsc strict clean (ran proactively).
- `pnpm check` green across all workspaces (apps/cli 683, all
  packages); `pnpm lint` 0/0; `pnpm guard:core` clean.
- No request/response (LLM) path touched — deterministic compose +
  HTTP-faked delivery; the rider's check is the daemon-discipline
  + real-provider integration. No smoke:live applies.

## Status

P9-b2 child 1/2 done. The rider briefs delegated-objective status
over a real `TelegramProvider` (only the HTTP boundary faked) on a
`tickOnce` — `[Briefing]` body carrying the active objective's
spec; a second in-window tick is deduped by the real sidecar
(no re-POST); nothing-to-brief ⇒ no POST; a send failure is
fail-soft (logged, rider survives); a wild interval is clamped to
a working/stoppable rider. **Parent P9-b2 NOT flipped** — it stays
`[ ]` until child 2/2 (env-gated registration + concrete
objectives evaluator/actuator). Recorded as a deferred split in
the README Rejected ledger. No CAPABILITIES line this slice (a
split child is not an end-to-end bullet delivery — the line lands
when the parent is met).

## Decisions

- The split is honest and contract-sanctioned (split a bullet
  only if the parent stays `[ ]` until ALL children met): P9-b2's
  three pieces have very different cost/risk — the rider is
  tight + deterministic + verifiable now; the concrete objectives
  evaluator is LLM/smoke:live-class. Bundling them would force
  either a bloated commit or a dishonest partial flip.
- The rider mirrors `objectives-tick.ts` exactly so the two
  delegated-autonomy daemons share identical operational
  discipline (clamp / single-flight / fail-soft / unref) — an
  operator reasons about both the same way.
- `feat(api)`: a new production behaviour (the server can
  autonomously brief delegated-objective status), even though its
  env-gated activation is the next child — consistent with how
  P9-b1 shipped the objectives rider ahead of its env-gating.
