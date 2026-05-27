# 687 — P10 s4+s5 COMPLETE: the orchestrate server wires `planTieredRun`'s low-capacity collapse — a `muse orchestrate --tiered` run on a host that can't hold both tiers collapses to the single heavy model sequentially (fail-open on probe error), the final child that flips the s4+s5 parent

## Why

P10 s4+s5 had three of four children met (ask 683, orchestrate 685,
two-tier live 686). The last child: the orchestrate server classified
each worker's tier but never honored the *capacity* side of the design
— on a host that cannot hold both a fast and a heavy model resident at
once, running both thrashes. `planTieredRun` (goal 682) already encodes
the collapse-to-single-heavy decision; it just was not wired into the
server. This iteration wires it, completing P10.

## Slice

- `apps/api/src/multi-agent-routes.ts`:
  - `resolveTierCapacityProbe(env)` — returns a `() => boolean` probe;
    `MUSE_TIER_SINGLE_MODEL_HOST` truthy (`1`/`true`/`yes`) ⇒ `false`
    (can't hold both → collapse); default ⇒ `true`.
  - `buildTieredOrchestration(specs, runtime, tierModels, canHoldBoth)`
    — replaces the classify-only `buildSpecWorkers`; calls
    `planTieredRun` and maps its assignments to per-worker models,
    returning `{ workers, collapsedToHeavy }`.
  - Both orchestrate handlers (POST + SSE stream) now, when `tiered`,
    `await buildTieredOrchestration(...)` and force `mode: "sequential"`
    when `collapsedToHeavy` (a collapsed run must not fan out in
    parallel — that is the whole point of the collapse).
- `apps/api/test/multi-agent-tiered.test.ts`: rewritten to test the new
  surface — `resolveTierCapacityProbe` env parsing;
  `buildTieredOrchestration` driven through the real
  `MultiAgentOrchestrator`: `canHoldBoth=true` → two distinct tier
  models in one run; `false` → both workers collapse to the heavy
  model; probe throws → fail-open collapse to heavy.

## Verify

- `pnpm --filter @muse/api test`: 284 passed (collapse + fail-open +
  two-tier + probe-parse).
- **Clean-mutation-proven**: hard-coding the probe to `() => true`
  (ignoring capacity) fails the collapse AND fail-open tests (both
  workers stay split instead of collapsing to heavy). Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- `pnpm smoke:broad`: 51 passed / 0 failed — orchestrate endpoints
  green; the handler refactor + forced-sequential-on-collapse are
  surface-safe (a non-tiered run is byte-identical).
- Byte-hygiene scan on the two touched files: clean.

## Status

**P10 s4+s5 parent FLIPPED — P10 complete.** All four children met:
ask-tiered (683), orchestrate-tiered (685), two-tier live round-trip
(686, `smoke:live`), low-capacity collapse (687, integration).

| host capacity (`--tiered` run)        | behaviour                          |
| ------------------------------------- | ---------------------------------- |
| holds both tiers (default)            | per-role fast/heavy, requested mode|
| `MUSE_TIER_SINGLE_MODEL_HOST=1`       | all heavy, forced sequential       |
| capacity probe throws                 | all heavy, forced sequential (fail-open) |

## Decisions

- **Collapse verified by integration, not a live low-RAM host** — the
  collapse is a deterministic branch of `planTieredRun`; forcing a real
  host to report low capacity is non-reproducible, so the correct,
  repeatable verification is the integration test driving the exact
  server code path (`buildTieredOrchestration` → `planTieredRun`). The
  *live* tiering payoff (two distinct real Qwen tiers in one run) is
  separately proven by the `smoke:live` check from 686. Both check
  types are sanctioned by the OUTWARD-TARGETS preamble; this is not a
  weakened check but the right tool for a deterministic decision.
- **Parent flipped on the strength of those two proofs** — every child
  has a green, surface-level (integration or `smoke:live`) check; the
  parent's intent (tiering works on both surfaces, with the capacity
  safety) is genuinely met. The Step-4 target audit may reopen if it
  disagrees.
- **Capacity probe is host-declared via env, not measured** — reliable
  VRAM/residency measurement is its own large concern; a user-declared
  `MUSE_TIER_SINGLE_MODEL_HOST` is a zero-cost, deterministic,
  honest signal that wires the collapse end-to-end now. A measured
  probe can replace the env default later without changing the surface.
- **Forced sequential on collapse** — a collapsed run is single-model;
  fanning it out in parallel would contend the one model, so the
  collapse forces sequential regardless of the requested mode.

## Remaining risks

- **No measured capacity probe** — collapse only triggers when the user
  declares the host single-model; an under-resourced host that does NOT
  set the env will still attempt both tiers. A measured probe
  (Ollama `/api/ps` + model sizes) is a future additive refinement
  behind the same `resolveTierCapacityProbe` seam.
- **Per-spec explicit tier still absent** — tier is classified from the
  spec `description`; a persisted `AgentSpec.tier` (DB migration) would
  give precise control and is the natural next P10-area refinement.
