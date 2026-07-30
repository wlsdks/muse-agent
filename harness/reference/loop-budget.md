---
title: Loop Control & Budget
audience: [developers, AI agents]
purpose: The termination conditions and budget caps that guarantee an agent loop ends without infinite repetition or cost blowout
status: draft
updated: 2026-07-19
sources_basis: [host CLAUDE.md (e.g. Muse) (tool loops have explicit limits/timeouts), host architecture rules (deterministic budgets/stop conditions), Claude Code agent-loop (max_turns/max_budget_usd), 2026 runaway-cost prevention guides]
related: [../core/team-roles.md, failure-modes-and-observability.md, ../core/verification-and-guardrails.md, architecture.md, ../README.md]
---

# Loop Control & Budget

> **Why this slot?** A slot that was empty in the [architecture](architecture.md) self-assessment
> (now ✅). An agent loop repeats "model call → parse output → run tool", and unless it is made to
> **end, guaranteed**, you get infinite repetition and cost blowout (in 2026 there were even cases
> of a single loop burning tens of thousands of dollars). Muse already puts limits and timeouts on
> tool loops (SYSTEM-MAP #1 · CLAUDE.md); this codifies that termination contract at the harness
> level. Prose only (no code).

## 0. The one-line principle

**Every loop ends on a hard cap — a hard stop, not a soft warning.** A warning is only a
notification; what stops the loop must be an enforced limit.

## 1. The terminating limits (keep all three)

- **Iteration cap** — a ceiling on tool calls/turns per task (e.g. max turns). Exceed it and the
  loop ends on the spot.
- **Time cap** — wall-clock timeouts on the whole task and on individual calls, so one stuck call
  cannot stall the loop.
- **Budget cap (cost/tokens)** — a token/cost limit per run. Exceed it and hard stop (the moment
  cumulative cost touches the limit).

If **any one** of the three limits is reached, the loop stops and records why (iterations / time
/ budget) in the result.

## 2. Terminating conditions (beyond the limits)

- **Task-completion signal** — normal termination when acceptance criteria are met
  ([harness-acceptance](harness-acceptance.md)).
- **No-progress detection** — repeating the same action or making no new progress (loop
  stagnation) → cut and escalate to a human.
- **Stuck (BLOCKED)** — if you don't know the answer, don't guess; stop and write it in
  `## Open questions` ([handoff-template](../core/handoff-template.md)).

## 2.5 Keep the PLAN-review budget and the BUILD↔EVAL budget separate

The two loops have different purposes and termination signals, so they do not share a counter.

- **PLAN-review budget** — write the maximum time and cost in the header first. Never issue a
  `BLOCKED` verdict on the raw `PLAN FAIL` count alone. **Material progress** is a change that
  closes a previous blocker or makes acceptance/accounting measurable. **No-progress** is the same
  blocker repeating with no new evidence or fix. Only no-progress or reaching the declared
  time/cost cap justifies escalating PLAN to `BLOCKED`.
- **BUILD↔EVAL budget** — separate from PLAN, keep caps on concrete regression-fix iterations,
  time, and cost. Evaluation feedback must return blockers bundled — everything reasonably
  discoverable in one pass. A new blocker in a later pass must record why it could not have been
  found in the previous pass; an unexplained blocker drip counts as no-progress.

Each pass records in the handoff status log: `budget kind`, cumulative usage,
`material-progress | no-progress`, closed blockers, and new evidence. Never borrow one loop's
remaining budget as grounds for another loop's retry.

Mass synthetic generation and controlled replay are budget consumption, not evidence quality. In
accounting, separate generation units from execution units, and keep `dataOrigin` and
`executionEvidence` as independent axes. `realismProxy` coverage or dry-run success never
increases live trials/inference requests.

## 3. Safety mechanisms that cut a runaway

- **Circuit breaker** — on detecting cascading tool failures or anomalous behavior, cut the loop
  even before the limits.
- **Retries are finite with backoff** — no infinite retries; exponential backoff + a maximum
  count.
- **Deterministic enforcement** — these limits operate as **fixed rule code**, not "model
  judgment" (matching the deterministic budgets/stop conditions of the [architecture rule]).

## 4. Operating for lower cost (alongside the limits)

- **Context is cost** — the longer the context, the more every call costs. Scheduling
  **compaction** every 10–15 tool calls saves tokens substantially while preserving quality
  (depth: [context-compaction](context-compaction.md)).
- **Cheap checks first** — run cheap guardrails/verification in parallel before expensive model
  calls ([verification-and-guardrails](../core/verification-and-guardrails.md)).
- **Model tiering** — fast models for simple work, strong models only for deep reasoning
  ([team-roles](../core/team-roles.md)).

## 5. One-line summary (loop-termination checklist)

1. Are all three hard caps — **iterations, time, budget** — in place?
2. On reaching a limit, does it **hard-stop** and record the reason (not a warning)?
3. Are the PLAN-review and BUILD↔EVAL budgets separate, and does it **terminate normally** on
   completion, stagnation, or being stuck?
4. Is there a **circuit breaker + finite backoff** for runaways?
5. Are the limits enforced by **code, not the model**?

---

## Sources (verified basis)

- Host project (e.g. Muse) — `CLAUDE.md` ("Tool output is untrusted. Tool loops have explicit limits and timeouts.")
- Host project (e.g. Muse) — `.claude/rules/architecture.md` ("Deterministic code for policy, permissions, budgets, and stop conditions.")
- Claude Code — [How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop) (max_turns / max_budget_usd hard caps + termination reasons)
- [How to Prevent Infinite Loops and Spiraling Costs](https://codieshub.com/for-ai/prevent-agent-loops-costs) (hard caps · timeouts · circuit breakers)
- [AI Agent Loop Token Costs: Constrain Context](https://www.augmentcode.com/guides/ai-agent-loop-token-cost-context-constraints) (context=cost, compact every 10–15 calls)
