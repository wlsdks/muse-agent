# Programmatic Tool Calling (PTC) — design

> Status: **SHIPPED ✅** (2026-06-30, branch `feat/programmatic-tool-calling`). Source mirror:
> hermes-agent `tools/code_execution_tool.py` (MIT/Apache) — pattern reimplemented Muse-native, not
> copied. Picked 2026-06-30 by Jinan as the "big bet" from the openclaw/hermes capability comparison.
>
> **What shipped** (all phases independently maker≠judge verified; journal:
> `docs/goals/loops/programmatic-tool-calling.md`):
> - Phase 1 — pure plan schema + DAG interpreter (`agent-core/tool-plan.ts`): backward-`$`-ref-only
>   (acyclic by construction), value-level substitution (injection guard).
> - Phase 2 — `AgentRuntime.executeToolPlanGated`: every step reuses the native gated path
>   (approval + arg-grounding); a blocked step aborts (no partial effect).
> - Phase 3 — `run_tool_plan` tool + grounding: only the projected result re-enters context as a
>   citable source, so `verifyGrounding` keeps fabrication=0; intermediate outputs never leak.
> - Phase 4 — live proof on gemma4:12b: with few-shot, 4/4 selection + VALID nested-plan emission
>   (0/2 without — a new tool is invisible to a 12B without exemplars).
> - Phase 5 — production wiring: `applyToolExemplars` injects the tool-exemplar few-shot into the
>   live prompt + a seeded `RUN_TOOL_PLAN_EXEMPLAR_BANK` (default-on, `MUSE_TOOLS_ENABLED` /
>   `MUSE_TOOL_EXEMPLARS` opt-outs).
> - Hardening — closed-set result/arg projections `count` / `first` / `last`.
>
> **Deferred (grow from real need, §3A/§7):** `filter`-by-literal (a larger grammar); v2 sandboxed
> arbitrary code (a much bigger security review — the plan-first form was shipped precisely to avoid
> it). The transform set + a wider exemplar bank grow from real traces, not speculation.

## 1. The problem it solves (Muse's self-documented #1 bottleneck)

Muse runs a local ~12B model. Its binding constraint is **multi-step tool chaining**: a 5-call
task degrades because (a) coherence drops after 2–3 inference rounds, and (b) every intermediate
tool result is pasted back into a small `num_ctx`, so the context fills with noise before the task
finishes. This is the exact weakness recorded in the computer-control axis.

**PTC collapses an N-step tool chain into ONE inference.** The model, in a single shot, emits a
*plan/script* that calls several tools and says how each output feeds the next; Muse executes it
deterministically; **only the final result re-enters the model's context** — the intermediate tool
outputs never do. One inference, bounded context, deterministic data-flow.

This is orthogonal to the openclaw "plain-text tool-call promotion" gap (rescuing a *single* call
the model wrote as text). PTC is the *multi*-call layer.

## 2. The core mechanism (hermes, for reference)

hermes exposes one tool, `execute_code`. The model writes a Python script that calls Hermes tools
over a local RPC (UDS/file); the tools run in the trusted host; only the script's **stdout** is
returned to the model. Intermediate results stay out of the window.

## 3. Muse-native design — the central decision

Executing **arbitrary model-written code** is a new execution surface, which collides head-on with
Muse's safety posture (risky execution must route through `crates/runner`, fail-close). So the
design has two candidate shapes, and the recommendation is to ship the safe one first:

### 3A. RECOMMENDED v1 — a structured tool-orchestration PLAN (no arbitrary code)

The model emits a **typed plan** (not free code): an ordered list of steps, each a tool call whose
arguments may reference prior steps' outputs by a binding name, plus a final projection expression.
Muse interprets the plan deterministically.

```jsonc
// what the model emits (one inference), via a single tool `run_tool_plan`:
{
  "steps": [
    { "as": "events", "tool": "calendar_list", "args": { "from": "today", "to": "next week" } },
    { "as": "free",   "tool": "availability",  "args": { "around": "$events" } }   // $-ref to a prior step
  ],
  "result": "$free"   // only this is projected back to the model
}
```

- **Data-flow without context bloat**: `$events` is substituted by the runtime from the prior
  step's output; the model never SEES the full event list — it only named the dependency.
- **No code execution surface**: there is no `eval`, no sandbox escape risk, no new RCE class —
  the "language" is a closed plan schema interpreted by Muse. This is why it ships first.
- **Bounded transforms**: a small, audited set of pure projections (pick a field, filter by a
  literal, count, first/last) — NOT arbitrary expressions. Anything richer is a follow-up.
- Captures ~80% of PTC's value (N calls / 1 inference / intermediate results out of context) at
  ~20% of the risk.

### 3B. v2 (only if the plan proves too limited) — sandboxed JS

The model writes a JS script run in a HARD sandbox: a dedicated child process (via `crates/runner`)
with **no fs / no net / no env / no process** — its ONLY capability is the tool-RPC over a pipe.
Deferred until the plan's expressiveness is measured insufficient; it is a much larger security
review.

## 4. Integration seams (verified in the repo)

- **Expose ONE tool** `run_tool_plan` (`tool-calling.md`: small set, clear "use when… / not
  when…"). Description: *"use when a task needs SEVERAL tool calls or passing one tool's output
  into another; do NOT use for a single call."* Add an `eval:tools` golden case (incl. the
  negative: a single-call task must NOT pick it).
- **Every step routes through the EXISTING gates.** The plan interpreter calls the same
  `AgentRuntime` tool-execution path that native calls use — `toolApprovalGate`
  (`agent-runtime.ts:870`) + `groundToolArguments` (`:947`). A `write`/`execute`/outbound tool
  inside a plan is STILL gated and draft-first; PTC must not become an approval bypass. This is a
  hard invariant.
- **Grounding is preserved (fabrication=0).** Each step's tool output, though kept out of the
  model's context, is appended to the run's citable sources, so the final answer the model writes
  from `result` is still checked + cited by the recall/citation gate. PTC keeps intermediate data
  out of the *prompt*, never out of the *grounding evidence*.
- **MuseTool shape** (`packages/tools/src/index.ts`: `{name, inputSchema, risk, groundedArgs}`) is
  the stub source — the plan can only reference registered tools; an unknown tool name is a
  deterministic parse error (no fabricated tools).

## 5. Hostile review (the risks that must be closed before build)

1. **Approval/outbound bypass** — *the #1 risk.* A plan that calls a send/`write` tool must hit
   the same fail-close approval as a native call. Mitigation: the interpreter has NO direct tool
   access; it calls `AgentRuntime`'s gated path per step. Acceptance test: a plan containing an
   outbound send with the gate denying ⇒ **no send**, plan aborts.
2. **Grounding bypass / fabrication** — if step outputs never reach the gate, the model could
   fabricate a `result`. Mitigation: append every step output to the citable-source set; the
   final answer runs the normal citation gate. Acceptance: a plan whose result claims a fact not
   in any step output ⇒ dropped/"I'm not sure".
3. **Resource exhaustion / loops** — a plan with huge fan-out or a cyclic `$`-ref. Mitigation:
   the plan is a DAG (cycle ⇒ parse error), a max-steps cap, a per-step + total timeout, and the
   existing tool-loop budget. No unbounded iteration in v1 (no loops in the plan language).
4. **Injection via tool output** — a `$events` value carrying "ignore previous instructions"
   substituted into a later step. Mitigation: `$`-substitution is DATA binding only (typed value
   into an arg slot), never re-parsed as plan/instructions; the existing
   `neutralizeInjectionSpans` still runs on anything that reaches the model.
5. **Over-selection** — the model using `run_tool_plan` for a single call (worse than a native
   call). Mitigation: the "do NOT use for a single call" description + an `eval:tools` negative
   case + a runtime nudge (a 1-step plan is unwrapped to a native call).

## 6. Phased build (each a verifiable slice)

1. **Plan schema + DAG interpreter** (pure, no model) — Zod schema, cycle/unknown-tool/`$`-ref
   validation, topological execution against a tool-executor seam. Unit-tested deterministically.
2. **Wire to AgentRuntime's gated path** — each step through approval + arg-grounding; the 5
   hostile-review acceptance tests (deny ⇒ no effect; fabrication ⇒ dropped; cycle ⇒ error;
   injection ⇒ data-only; 1-step ⇒ unwrapped).
3. **Expose `run_tool_plan` + grounding wiring** — step outputs → citable sources; final answer
   through the citation gate. `eval:tools` golden (positive multi-step + negative single-call).
4. **Live proof** — `smoke:live` / `eval:tools` with `MUSE_EVAL_REPEAT` on gemma4: a real
   multi-step task completes in ONE inference with intermediate results absent from context, and
   the answer is grounded. Measure the delta vs the per-tool loop.

## 7. Open decisions for Jinan

- **v1 = structured plan (3A), v2 = sandboxed code (3B) deferred** — recommended. Confirm, or
  insist on the full code path now (bigger security review).
- **Transform set** for the plan's projections — start minimal (pick/filter-by-literal/count/
  first-last) and grow from real needs?
- **Branch/autonomy** — build on a fresh `feat/programmatic-tool-calling` branch, Tier1 (local
  commits, no push) as before?
