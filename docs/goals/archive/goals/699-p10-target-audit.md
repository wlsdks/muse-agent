# 699 — P10 target-completion audit (the P→P seam check)

## Why

Audits exist for P0–P9; P10 (tiered local-model orchestration) was the
oldest completed target with no `P10 audit —` line. Per the
iteration-loop PROCEDURE Step 4, when every bullet of a target is `[x]`
and no audit line exists, the sole mandate is to re-run every
`CAPABILITIES.md` check that delivered that target's bullets TOGETHER
AND exercise the target as one end-to-end user flow against the
falsifiable test — catching "marked done but went sideways" at the
seam.

P10's five slices:
- s1 (681): `AgentWorker.model` per-worker dispatch override.
- s2+s3 (682): `classifyTier` + `planTieredRun` (capacity collapse,
  fail-open).
- s4 (683 ask, 685 orchestrate): `routeAskTierModel` + `muse ask
  --tiered`; `buildTieredOrchestration` + `muse orchestrate --tiered`.
- s5 (686 two-tier-live, 687 collapse): the live two-tier round-trip +
  the orchestrate-server capacity collapse.

## Verify (all re-run green TOGETHER)

- `@muse/multi-agent` 60/60 — s1 dispatch (multi-agent.test.ts) + s2/s3
  (tiering.test.ts).
- `@muse/api` multi-agent-tiered.test.ts 7/7 — s4 orchestrate +
  `resolveTierCapacityProbe` collapse / fail-open; this is the seam
  where `buildTieredOrchestration` composes spec-role → `classifyTier`
  → `planTieredRun` → per-worker `AgentWorker.model` → the real
  `MultiAgentOrchestrator` dispatch (the server's exact production
  path).
- `@muse/cli` 21/21 — s4 `routeAskTierModel` + the `--tiered` flags
  (commands-ask + commands-orchestrate) — and program.test.ts
  `muse ask --tiered` 1/1.
- `pnpm check`: EXIT=0 across the whole workspace.
- **End-to-end user flow (falsifiable test)** — `pnpm smoke:live`:
  PASS "POST /api/multi-agent/orchestrate --tiered (live) — two workers
  run on two distinct local Qwen tiers" (fast=qwen3:8b,
  heavy=qwen3.6:35b-a3b). One `muse orchestrate --tiered` run executed
  two workers on two DISTINCT real local models — re-ran green this
  audit.

## Status

**PASS.** P10's five slices ARE a composed chain, not disconnected
pieces: the role classifier feeds the capacity-aware planner, which
assigns per-worker models the orchestrator dispatches, proven both
deterministically (multi-agent-tiered composes the server path whole)
and live (smoke:live runs two real Qwen tiers in one orchestration).
No drift; no bullet reopened. P10 is genuinely delivered end-to-end.

A `P10 audit — … — PASS` line is appended to the
`docs/goals/README.md` Rejected ledger.

## Decisions

- **No new seam test** — unlike earlier audits where the pieces lived
  in packages that composed nowhere, P10's composition seam already has
  a real home: `apps/api/test/multi-agent-tiered.test.ts` drives
  `buildTieredOrchestration` (the server's exact composition) end-to-end
  through the real orchestrator, and `smoke:live` proves the full
  CLI→server→two-real-models flow. Adding a redundant seam test would
  be inward churn; the audit re-runs the existing composition checks
  together and records the result.
- **Audit is steering upkeep** — `docs(loop)`, not a counted iteration;
  no source change.

## Remaining

- **P11–P16 audits pending** — those targets all flipped recently (this
  loop's burst). Per Step 4 ("one iteration per completed target"),
  each gets its own audit in a subsequent iteration, oldest first
  (P11 next).
