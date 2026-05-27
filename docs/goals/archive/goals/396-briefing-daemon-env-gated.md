# 396 — Situational-briefing daemon env-gated (P9-b2 split child)

## Why

Continuity: 394 shipped the P9-b1 objectives rider; 395 shipped
the P9-b2 situational-briefing rider. P9-b2's remaining work is
"both riders env-gated + registered in the apps/api daemon set,
concrete evaluator/actuator wired". That still bundles two pieces
of very different cost: env-gating the **deterministic**
situational-briefing daemon (zero-LLM, mechanical mirror of
`startFollowupDaemonIfConfigured`) vs the **objectives** daemon,
which needs a concrete agent/LLM condition-evaluator
(smoke:live-class). This slice delivers the deterministic half
completely; the objectives evaluator stays the remaining child
(parent P9-b2 still `[ ]`).

## Slices

- s1 = P9-b2 rider child (395, done).
- s2 (THIS) = the situational-briefing daemon env-gated +
  registered end-to-end:
  - `apps/api/src/tick-daemons.ts`:
    `startSituationalBriefingDaemonIfConfigured` — exact mirror of
    `startFollowupDaemonIfConfigured`: off unless
    `MUSE_BRIEFING_PROVIDER` + `MUSE_BRIEFING_DESTINATION` set,
    `objectivesFile` + `briefingSidecarFile` present, the named
    provider registered; reads `MUSE_BRIEFING_TICK_MS` /
    `MUSE_BRIEFING_WINDOW_MS` / quiet-hours; `addHook("onClose",
    stop)`.
  - `apps/api/src/server-options.ts`: `objectivesFile?` +
    `briefingSidecarFile?`.
  - `packages/autoconfigure`: `resolveObjectivesFile` /
    `resolveBriefingSidecarFile` (`~/.muse/objectives.json` /
    `briefing-fired.json`, env-overridable) wired into
    `api-server-options.ts`.
  - `apps/api/src/server.ts`: one call alongside the sibling
    daemons.
  Verified by `apps/api/test/situational-briefing-daemon.test.ts`.
- s3 (next) = the objectives daemon env-gated + a concrete
  production agent/LLM condition-evaluator/actuator. Flipping it
  flips parent P9-b2.

## Verify

- `apps/api/test/situational-briefing-daemon.test.ts` 4/4 (run
  directly) and within `pnpm --filter @muse/api test` (183 pass);
  tsc strict clean (ran proactively).
- `pnpm check` green across all workspaces (apps/cli 683, all
  packages incl. autoconfigure + apps/api); `pnpm lint` 0/0;
  `pnpm guard:core` clean.
- No request/response (LLM) path touched — env-gating discipline
  + deterministic daemon. No smoke:live applies.

## Status

P9-b2 child (situational-briefing daemon env-gated+registered)
done: with env + options + a registered provider the daemon-set
function registers an `onClose` stop hook (started + stoppable);
absent env, missing options, or an unregistered provider ⇒ NOT
started. The configured server now actually runs the
situational-briefing daemon, off by default. **Parent P9-b2 NOT
flipped** — the objectives daemon env-gating + a concrete
agent/LLM condition-evaluator (smoke:live-class) remains. Recorded
as PROGRESS on the deferred split in the README ledger. No
CAPABILITIES line this slice (the line lands when the parent is
met end-to-end).

## Decisions

- This is cost-based decomposition, not salami-slicing: the
  deterministic briefing daemon is fully, genuinely productionised
  here (a real configured server runs it). The remaining child is
  the genuinely different-in-kind objectives evaluator (needs the
  agent/LLM + smoke:live) — exactly the cost/risk asymmetry that
  justified the original P9-b2 split. The remaining child is ONE
  coherent unit; it will not be split further.
- The daemon-set function is an exact behavioural mirror of
  `startFollowupDaemonIfConfigured` (same off-by-default →
  env-gate → `addHook('onClose', stop)` shape) so an operator
  reasons about every tick daemon identically.
- `feat(api)`: a new production behaviour (a configured server
  autonomously briefs delegated-objective status), consistent with
  the followup / proactive / pattern daemon wirings.
