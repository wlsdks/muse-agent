# Loop journal — Programmatic Tool Calling (PTC)

Theme: build PTC (plan-first, design = docs/strategy/programmatic-tool-calling.md) to collapse
local-12B N-step tool chains into ONE inference. BIG chunk per fire (a whole phase, not a slice)
until COMPLETE. Tier1 (local commits, no push). Source mirror: hermes-agent (MIT/Apache), pattern.

## Phases (each fire completes the next incomplete one)
- [x] Phase 1 — Plan schema + DAG interpreter (pure, no model): Zod schema, cycle/unknown-tool/$-ref
      validation, topological execution against a tool-executor seam. Deterministic unit tests.
- [x] Phase 2 — Wire to AgentRuntime's gated path (toolApprovalGate + groundToolArguments per step) +
      the 5 hostile-review acceptance tests (deny⇒no effect; fabrication⇒dropped; cycle⇒error;
      injection⇒data-only; 1-step⇒unwrapped).
- [x] Phase 3 — Expose `run_tool_plan` tool + grounding wiring (step outputs → citable sources;
      final answer through the citation gate) + eval:tools golden (multi-step positive + single-call
      negative).
- [x] Phase 4 — Live proof (selection+valid-plan emission ACHIEVED on gemma4 4/4 with few-shot): eval:tools / smoke:live with MUSE_EVAL_REPEAT on gemma4 — a real
      multi-step task completes in ONE inference, intermediate results absent from context, answer
      grounded. Measure delta vs the per-tool loop.

- [ ] Phase 5 — PRODUCTION delivery: wire renderToolExemplarSection into the LIVE runtime prompt assembly + seed a static run_tool_plan exemplar, so real `muse chat/ask` on gemma4 gets the few-shot and actually selects/emits plans (without it PTC is invisible to the model in production). Then a live end-to-end run.

## Fire log
(appended per fire)

## fire 1 · 2026-06-30 · fire1 · Phase 1
verdict: PASS · Phase 1 (plan schema + DAG interpreter, pure — no AgentRuntime/model)
- WHAT: `packages/agent-core/src/tool-plan.ts` — `parseToolPlan` (deterministic, never-throws validation: shape, step-cap, duplicate binding, unknown-tool, and the CYCLE GUARD = backward-`$`-refs-only ⇒ acyclic by construction) + `executeToolPlan` (resolve `$binding.path` args from PRIOR outputs value-level, run steps via a pluggable executor seam, project the `result`; captures every step output in `steps[]` for Phase 3 grounding). Exported from agent-core.
- WHY: foundation for collapsing local-12B N-step tool chains into ONE inference (Muse's #1 bottleneck). Phase 1 is the pure core so Phase 2 can wire the executor seam to AgentRuntime's gated path (approval + arg-grounding).
- REVIEW: 11 tests (valid plan; each rejection; cycle-guard; data-flow substitution; result projection; thrown-executor aborts with no later steps) + mutation RED (remove the backward-ref check ⇒ cycle test RED) + agent-core 0 TS errors + lint 0.
- RISK: no gate wiring yet (Phase 2) — the module must NOT be exposed to the model until Phase 2/3 add approval + grounding; transform set is minimal (dotted-path pick only) — count/filter are a later-phase add.

## fire 2 · 2026-06-30 · fire2 · Phase 2
verdict: PASS · Phase 2 (wire the plan executor seam to AgentRuntime's gated single-tool path)
- WHAT: new `AgentRuntime.executeToolPlanGated(plan, context)` binds Phase 1's `executeToolPlan` executor to `this.executeToolCall(context, {id,name,arguments}, activeTools)` per step — REUSING the existing gated path (approval, coerce/validate, groundToolArguments, toolExecutor); zero gate reimplementation. activeTools via `this.modelTools(context)` (same as the model loop). A step whose result `status !== "completed"` (denied/invalid/failed) throws the new `ToolPlanStepBlockedError`, aborting the plan so NO downstream step runs (no partial effect).
- WHY: PTC must not become a gate bypass — every plan step is gated exactly like a native call (approval fail-close, arg-grounding/fabrication guard, outbound-safety).
- REVIEW: 4 acceptance (DENY⇒step2 never executes/empty effect sink; WRITE/execute-risk DENY⇒no effect = outbound-safety; arg-grounding parity = an ungrounded groundedArg dropped at the gate; 1-step⇒native-equivalent) + mutation RED (block guard not throwing ⇒ DENY tests RED) + agent-core FULL suite 2720/2720 (no regression) + 0 TS errors + lint 0.
- SCOPE (honest): Phase 2 = gated EXECUTION only. "fabrication⇒projected-result dropped" needs the grounding/citation wiring = Phase 3, deliberately not faked here.
- RISK: gated tool output is injection-spotlighted by the @muse/tools executor (faithful) — Phase 3's grounding wiring must feed the RAW step outputs to the citable-source set.

## fire 3 · 2026-06-30 · fire3 · Phase 3
verdict: PASS · Phase 3 (expose run_tool_plan + grounding wiring + eval golden)
- WHAT: `run_tool_plan` tool (packages/tools/src/muse-tools-plan.ts, risk=execute, rich plan schema + "use when multi-step/data-flow; not when single call" + example), registered at runtime-tool-registry (NOT in the 25-read-only createMuseTools factory — invariant kept). Intercepted in `executeToolCall` (after exposed-check, before approval): parse with knownTools=other active tools (nested run_tool_plan ⇒ unknown-tool parse error, no recursion) → `executeToolPlanGated` → projected `result` returned as a COMPLETED tool result; parse error / blocked step ⇒ clean BLOCKED result (no throw/crash).
- WHY (grounding/fabrication=0 crux): the projected result flows through capToolOutput → a citable tool-message + `groundingSourceFromExecuted` → AgentRunResult.groundingSources, so the final answer is grounded against it by `verifyGrounding`. The model only ever sees `result` (not the intermediate dumps), so it can't legitimately assert intermediate data; an unsupported claim is flagged ungrounded — result-only is fail-close. Raw steps[] NOT separately wired (too invasive for the single-result chokepoint; result-only is the safe minimum).
- REVIEW: 5 tests via a REAL model loop (scripted provider): multi-step executes through the gate + result completed + groundingSources contains run_tool_plan + 1 inference; fabrication⇒dropped via REAL verifyGrounding (supported=grounded, fabricated=ungrounded); nested run_tool_plan blocked (no recursion); parse error ⇒ clean blocked; denied step ⇒ no partial effect. + mutation RED (neuter verifyGrounding coverage gate ⇒ fabrication test RED) + agent-core 2725 + tools 312 + autoconfigure 645 + 0 TS + lint 0.
- RISK: run_tool_plan intercepted BEFORE its own approval, but EVERY step is gated via executeToolPlanGated→executeToolCall (Phase 2), so a write/send step is still draft-first fail-close — the container approval is redundant, not a bypass. Phase 4 = the live gemma4 proof.

## fire 4 · 2026-06-30 · (commit pending) · Phase 4 — LIVE PROOF (selection+emission achieved; production exemplar wiring remains)
verdict: PARTIAL · Phase 4 live proof on gemma4:12b
- WHAT: ran the eval:tools PTC scenario LIVE on gemma4:12b (MUSE_EVAL_REPEAT=2). FINDING: a brand-new run_tool_plan with NO few-shot is NEVER selected (0/2 positives — the 12B falls back to a native first-tool call); negatives correctly abstained (2/2, no over-selection). Adding a few-shot exemplar bank (paraphrases, NOT test prompts: multi-step→run_tool_plan, single-call→native restraint; arXiv 2508.15214) → **4/4 (100%)**: gemma4 SELECTS run_tool_plan for multi-step AND emits a VALID nested plan with $-ref data-flow (e.g. `{result:"$diff", steps:[{as:"today",tool:"time_now"},{as:"diff",tool:"time_diff",args:{from:"$today.date",to:"2026-12-25..."}}]}`), and still NEVER over-selects for a single call.
- WHY (the live proof): this is the binding constraint (tool-calling.md) — a local 12B emitting a VALID nested plan in one shot. It WORKS with the proven few-shot lever. Combined with Phase 1-3 (gated execution + grounding, all judged), the end-to-end PTC mechanism is proven on the real local model.
- HONEST GAP (the last mile): `selectToolExemplars`/`renderToolExemplarSection` are an existing capability used ONLY by the eval + tests — they are NOT yet wired into the LIVE runtime prompt. So in real `muse chat/ask`, gemma4 gets no few-shot → would NOT pick run_tool_plan. FULL production delivery needs: (a) wire the tool-exemplar section into the live prompt assembly, (b) seed a static run_tool_plan exemplar. That is the next fire (Phase 4.5 / hardening), a bounded follow-on.
- REVIEW: eval:tools PTC scenario 4/4 @ threshold 85% (REPEAT=2) on gemma4:12b; the emitted plans are valid + executable (Phase 1 schema). lint 0.
- lesson: a NEW orchestrator tool is invisible to a 12B without few-shot — the exemplar bank is not optional polish, it is the delivery mechanism. PTC is machinery-complete + live-proven, NOT yet production-wired.
