# Loop journal — multi-agent (오케스트레이션·서브에이전트 핸드오프 신뢰성)

Theme: lead-worker orchestration / sub-agent handoff reliability (MAST coordination-failure
guards · handoff schema validation · explicit termination). Worktree `/tmp/muse-multi-agent`,
branch `loop/multi-agent`. Tier2 (push every fire; merge-to-main every 3rd fire).

## fire 3 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 8c2b8e8f
meta: value-class=wiring · pkg=@muse/api · kind=response-dto-exposure · verdict=PASS · firesSinceDrill=2
ratchet: testFiles +1 (orchestrate-route-signal-exposure) · fabrication 0 · eval:orchestration/decomposition SKIP (Ollama down) · pkg/kind cell distinct (api/run-wiring f1 → multi-agent/guard f2 → api/dto-exposure f3) · consecutive allPASS=3 (drill at ≥8)

**What** — Surfaced the orchestrator's structured coordination signals (`conflicts`, `verification`)
from the opaque `response.raw` into BOTH API orchestrate route responses (POST `/orchestrate` return +
`/orchestrate/stream` done frame) via a new defensive `readOrchestrationSignals(raw: unknown)` extractor.
Previously the routes mapped only `response:{id,model,output}` and dropped `raw`, so a consumer received
only the human ⚠ line baked into the answer text — never the structured signal to act on.

**Why** — Completes fire 1's originally-stated HTTP acceptance (`raw.conflicts populated`). MAST:
withholding a detected coordination failure from the caller defeats the point of detecting it. A web
console / programmatic consumer can now render a conflicts badge or a coverage-incomplete state.

**Review points** — (1) MUTATION-FIRST: pre-wiring the 3 positive tests RED (no `conflicts`/`verification`
field), control GREEN; post-wiring all 4 GREEN. Independent Opus ④ judge re-ran the drill (removed both
spread sites → 3 fail/1 pass). (2) SIBLING pair: POST + stream done frame both wired AND tested (the
stream test parses the real `data:` SSE line). (3) Fail-safe narrowing: `raw` is `unknown` → null/non-object/
malformed yields NO field (control proves no noise); empty-array guard; no throw path. (4) Spread keys are
disjoint from the surrounding literal (no clobber).

**Risk** — Pure response-shaping; no model call, no egress, fabrication floor untouched. Conflicts assertion
is loose (length≥1 + names a worker) — acceptable; the verification test pins exact content, over-pinning a
stochastic conflict string would be brittle. LLM evals SKIP (Ollama down); slice proven by HTTP inject tests.

review: gates green — `pnpm --filter @muse/api build` clean · apps/api 871 pass · lint 0 · `pnpm check` exit 0 ·
independent Opus ④ judge VERDICT PASS.

## fire 2 · 2026-06-21 · multi-agent · loop-creator v2.0.0 · 0a9e81b4
meta: value-class=new-guard · pkg=@muse/multi-agent · kind=correctness-guard · verdict=PASS · firesSinceDrill=1
ratchet: testFiles +0 (case added to lead-worker.test.ts) · fabrication 0 · eval:orchestration/decomposition SKIP (Ollama down) · pkg/kind DIVERSE vs fire 1 (@muse/api/wiring → @muse/multi-agent/guard)

**What** — `runLeadWorkerTask` (decomposed lead-worker path) now short-circuits BEFORE
synthesis when `completed === 0` (every sub-task failed/ungrounded), returning an honest
`finalAnswer: ""` and SKIPPING the synthesizer. Previously it handed only failed/ungrounded
executions to `deps.synthesize` and returned that as the final answer — a confident answer
fabricated from zero grounded evidence.

**Why** — Fabrication=0 floor breach + MAST proceed-despite-failure. The single-agent path
already returned `""` on failure (line 279) and the orchestrator fan-out already throws
`No worker completed` — the decomposed lead-worker path was the inconsistent outlier that
let a non-answer masquerade as a synthesized answer. Found via gap-scout of the orchestration
code (no backlog item; the conflict/handoff guards were already mature).

**Review points** — (1) MUTATION-FIRST: pre-fix the new test RED (`finalAnswer` = "CONFIDENT
but ungrounded answer", synthesizeCalls=1); post-fix GREEN. Independent Opus ④ judge re-ran the
mutation drill (disabled guard → exactly the one test failed → restored → 207 pass). (2) SIBLING
AUDIT: all three all-failed paths now consistent (single-agent ""/fan-out throw/decomposed "").
(3) `completed` hoisted once (removed the duplicate at the old site, identical value). (4) Early
return is shape-correct vs LeadWorkerResult; dropped optionals (synthesisIncomplete/subtaskConflicts)
are meaningless with zero completed.

**Risk** — A genuinely all-ungrounded decomposition now returns "" rather than an "I'm not sure"
prose answer — but that matches the established single-agent convention (callers already treat
`finalAnswer === ""` as "no grounded answer"). No new contract burden. LLM evals SKIP (Ollama down);
slice proven by the deterministic unit test.

review: gates green — `pnpm --filter @muse/multi-agent build` clean · full pkg 207 pass · lint 0 ·
`pnpm check` exit 0 · independent Opus ④ judge VERDICT PASS.

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
