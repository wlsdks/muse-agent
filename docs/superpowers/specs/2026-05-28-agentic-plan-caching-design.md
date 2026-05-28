# Agentic Plan Caching for Muse — plan-template exemplars

Status: design / approved-direction (scope: exemplar-guidance, not skip-the-call)
Date: 2026-05-28
Paper: Agentic Plan Caching — Test-Time Memory for Fast and Cost-Efficient
LLM Agents (arXiv 2506.14852, 2025)

## Why (honest adaptation)

APC's headline is cloud cost −50% / latency −27% by reusing cached plan
templates to SKIP the planner call. Muse runs a small LOCAL free model,
so:

- The cost incentive doesn't apply (local, free).
- Exact-repeat skipping is already covered by the existing `responseCache`.
- "Skip the planner for a similar task" needs arg-adaptation (an LLM call
  or risky deterministic substitution) — net gain is marginal locally.

So Muse keeps APC's valuable, faithful core — **extract plan templates
from completed runs + match a similar one for a new task** — but uses the
match as a planning **few-shot exemplar** instead of skipping the call.
The payoff for a small local model is PLAN RELIABILITY (better one-shot
plans, `tool-calling.md`), not latency. This is distinct from the existing
curated-markdown exemplar system (that feeds the general system prompt;
this is auto-captured and feeds the PLANNING prompt).

## Constraints honoured

- Deterministic token-overlap retrieval; NO extra model round (the planner
  call already happens — it just gets a better prompt).
- Local JSON store (`~/.muse/plan-cache.json`), no DB / embedding migration.
- Single new store; cited in code (APC, arXiv 2506.14852).

## Design (mirrors the playbook end-to-end)

1. **Store** (`@muse/mcp/personal-plan-cache-store.ts`): `PlanCacheEntry
   {id, userId, prompt, steps, createdAt}`; `recordPlanTemplate` (upsert,
   cap 100), `queryPlanCache`; atomic/tolerant/quarantine.
2. **agent-core** (`plan-cache.ts`): duck-typed `PlanCacheProvider`
   (`findSimilarPlan`, `recordPlan`); `selectPlanExemplar(entries, prompt)`
   — most-similar by Jaccard token overlap (reuses `strategyTextSimilarity`,
   default minScore 0.3); `renderPlanExemplar(plan)` → compact `요청 + 계획
   JSON` string (capped 800 chars).
3. **prompts**: `buildPlanningSystemPrompt` gains `priorPlanExemplar?` →
   injects a `[Similar Past Plan]` section before `[User Request]`,
   instructing the model to adapt (not copy) it.
4. **plan-execute loop**: in `generatePlan`, fetch+render the exemplar via
   `runner.planCacheProvider.findSimilarPlan` (fail-open); after a
   successful run (≥1 step succeeded), `recordPlan(userId, prompt, plan)`.
   Threaded through `PlanExecuteRunner` / `ModelLoopRunner` → `AgentRuntime`.
5. **autoconfigure**: `buildPlanCacheProvider(env)` adapts the store +
   `selectPlanExemplar`; default-on, opt out with `MUSE_PLAN_CACHE=false`;
   `resolvePlanCacheFile` (`MUSE_PLAN_CACHE_FILE`).

Conservative: no userId / no match ⇒ no exemplar and no record. Only the
plan-execute path is affected (the model-loop path is untouched).

## Verification

- `prompts.test.ts`: exemplar injected before `[User Request]`; omitted
  when absent.
- `agent-core/test/plan-cache.test.ts`: `selectPlanExemplar` picks the
  most similar above threshold / none below / empty; `renderPlanExemplar`
  shape.
- `mcp/test/personal-plan-cache-store.test.ts`: record/query/filter/upsert/
  cap/tolerant-read.
- `agent-core/test/agent-runtime-plan-cache.test.ts` (integration): a
  plan-execute run records the plan; a cached similar plan is injected into
  the planning request; no userId ⇒ neither records nor injects.
- Gates: `pnpm check`, `pnpm lint`; `pnpm smoke:live` exercises the
  plan-execute path (capture runs against the real local model without
  breaking the request path).

## Out of scope

- Skipping the planner call + arg-adaptation (the faithful efficiency play
  — marginal on a local free model; deferred).
- Dedup-on-record by prompt similarity (the cap bounds growth; refine later
  if the cache fills with near-duplicate prompts).

## CAPABILITIES.md line (on delivery)

`- [Autonomy] The plan-execute planner reuses a similar PAST plan as a
few-shot exemplar so the small local model plans better in one shot
(Agentic Plan Caching, arXiv 2506.14852) — auto-captured to
~/.muse/plan-cache.json, retrieved by token overlap, injected as [Similar
Past Plan] — plan-cache.test.ts + agent-runtime-plan-cache.test.ts +
personal-plan-cache-store.test.ts + prompts.test.ts — research-applied
slice`
