# Loop journal — Programmatic Tool Calling (PTC)

Theme: build PTC (plan-first, design = docs/strategy/programmatic-tool-calling.md) to collapse
local-12B N-step tool chains into ONE inference. BIG chunk per fire (a whole phase, not a slice)
until COMPLETE. Tier1 (local commits, no push). Source mirror: hermes-agent (MIT/Apache), pattern.

## Phases (each fire completes the next incomplete one)
- [ ] Phase 1 — Plan schema + DAG interpreter (pure, no model): Zod schema, cycle/unknown-tool/$-ref
      validation, topological execution against a tool-executor seam. Deterministic unit tests.
- [ ] Phase 2 — Wire to AgentRuntime's gated path (toolApprovalGate + groundToolArguments per step) +
      the 5 hostile-review acceptance tests (deny⇒no effect; fabrication⇒dropped; cycle⇒error;
      injection⇒data-only; 1-step⇒unwrapped).
- [ ] Phase 3 — Expose `run_tool_plan` tool + grounding wiring (step outputs → citable sources;
      final answer through the citation gate) + eval:tools golden (multi-step positive + single-call
      negative).
- [ ] Phase 4 — Live proof: eval:tools / smoke:live with MUSE_EVAL_REPEAT on gemma4 — a real
      multi-step task completes in ONE inference, intermediate results absent from context, answer
      grounded. Measure delta vs the per-tool loop.

## Fire log
(appended per fire)
