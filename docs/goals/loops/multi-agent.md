# Loop journal — multi-agent (오케스트레이션·서브에이전트 핸드오프 신뢰성)

Theme: lead-worker orchestration / sub-agent handoff reliability (MAST coordination-failure
guards · handoff schema validation · explicit termination). Worktree `/tmp/muse-multi-agent`,
branch `loop/multi-agent`. Tier2 (push every fire; merge-to-main every 3rd fire).

## fire 1 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · b9e3ced9
meta: value-class=wiring · pkg=@muse/api · kind=cross-package-wiring · verdict=PASS · firesSinceDrill=0
ratchet: testFiles +1 (orchestrate-route-conflict-wiring) · fabrication 0 · eval:orchestration/decomposition SKIP (Ollama down on box)

**What** — Wired the already-built `detectFanInConflicts(parts, embed)` cross-worker
contradiction detector into BOTH API orchestrate routes (`/orchestrate` + `/orchestrate/stream`)
for production parity. Added `embed?` to `MultiAgentRouteOptions`, built `detectConflicts` from
it at both call sites, and threaded `embed: createGateEmbedder(process.env)` in `server.ts`.
When ≥2 workers complete and disagree on the same point, the route now appends the honest
"⚠ Workers disagree on the same point — reconcile before trusting: …" line to `response.output`
and sets `raw.conflicts` — previously the package seam existed (agent-hardening fire 18) but the
routes wired only `verifyFinalAnswer`, never `detectConflicts`, because no embedder was in scope.

**Why** — A coordination-failure surface (MAST: reasoning–action mismatch / information
withholding across workers) was built and package-tested but DARK in production: the API fan-in
silently concatenated contradicting worker answers as if one truth. This is the wedge mechanism
(grounding edge on the fan-OUT) reaching the real surface.

**Review points** — (1) MUTATION-FIRST: against unwired code the 2 positive HTTP tests went RED
(no ⚠ line, workers visibly disagree tuesday/wednesday), control GREEN; after wiring all 3 GREEN.
The independent Opus ④ judge re-ran the mutation drill itself and confirmed. (2) SIBLING pair:
both routes wired AND both tested. (3) Fixture is a GENUINE contradiction per
`detectPairwiseContradictions` real gates (cosine 1.0 ≥ topicSimMin, overlap 0.5 ≥ min,
neither-subset) — not rigged. (4) fail-soft + back-compat: no embed ⇒ silent (control test),
throwing embed ⇒ no conflicts.

**Risk** — Conflict detection now runs per orchestrate request with ≥2 completed workers (one
embedding pass over worker outputs). Cost is bounded, embedder is the shared local gate embedder
(no cloud egress, MUSE_LOCAL_ONLY-safe). LLM evals (`eval:orchestration`/`eval:decomposition`)
SKIPPED on this box (Ollama unreachable) — the slice is proven by the deterministic
contract-faithful HTTP test, which needs no model.

review: gates green — `pnpm --filter @muse/api build` clean · lint 0 · apps/api 867 pass ·
`pnpm check` exit 0 · independent Opus ④ judge VERDICT PASS.
