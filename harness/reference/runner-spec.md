---
title: Harness Runner Spec
audience: [developers, AI agents]
purpose: The execution contract that elevates handoff, roles, and gates from "a human fills the form" to "the runtime enforces it"
status: draft
updated: 2026-06-13
sources_basis: [harness-acceptance 9 measured runs, team-roles · role-prompts · handoff-template · verification-and-guardrails · loop-budget, Anthropic 3-agent harness (context reset · handoff artifacts)]
related: [../core/team-roles.md, ../core/handoff-template.md, ../core/role-prompts.md, ../core/verification-and-guardrails.md, loop-budget.md, architecture.md, ../README.md]
---

# Harness Runner Spec

> **Why this slot?** The harness now has roles, forms, and gates all defined, and has run 9 times
> with real Claude Code — but that flow was stitched together **by hand** (the chains in
> [harness-acceptance §7.5](harness-acceptance.md) are the evidence). To become "an exceptionally
> good harness", the cycle must be **enforced by a runtime** — the same forms and the same gates
> applied automatically no matter who runs it. This document defines that runner's **behavioral
> contract** (what it enforces) in prose. Not an implementation — "the contract the runner must
> keep".

## 0. The one-line principle

**The runner turns the cycle, not a human.** The runner automatically inserts role prompts, the
handoff form, gates, and limits; humans intervene only at approval points.

## 1. The enforced cycle of one task

The runner drives a task in the following order, and **each transition must pass its gate** to
proceed.

```
request ─▶ [PLAN] planner ──(plan gate)──▶ [BUILD] worker ──▶ [EVAL] evaluator
                                                                  │
                                    PASS ─▶ [LEARN] curator ─▶ DONE
                                    FAIL ─▶ feedback → [BUILD] (until the retry cap)
```

- ([LEARN] curator is a non-blocking learning stage *after* DONE — the runner state machine
  enforces up to DONE; learning is not a gate.)
- Each stage receives its block from [role-prompts](../core/role-prompts.md) **auto-injected**
  (no human attaches it).
- Each stage's output is recorded only in its own section of
  [handoff-template](../core/handoff-template.md), and the next stage receives **only that form**
  as input (context reset).

## 2. What the runner enforces (the contract)

- **Form enforcement** — each role's output must match the handoff-form schema. If not, one
  re-request; if it still fails, BLOCKED.
- **Plan gate (front)** — before BUILD, check the plan's **internal consistency** (are the
  acceptance criteria mutually non-contradictory; do examples and criteria agree). Only a pass
  enters BUILD. (※ The defense against "a wrong plan skews everything downstream" seen in golden
  measurement — see the [golden-set] observations.)
- **Completion gate (back)** — evaluator PASS + (where possible) automated grading must pass for
  DONE. Uncertainty blocks first.
- **Maker ≠ judge** — BUILD and EVAL are enforced as different agent instances (the evaluator
  never sees its own build).
- **Loop limits** — hard caps on iterations, time, and budget
  ([loop-budget](loop-budget.md)). The BUILD↔EVAL repetition is also capped; past it, BLOCKED and
  escalated to a human.
- **Compaction & checkpoints** — compact when things get long
  ([context-compaction](context-compaction.md)); checkpoint at each branch point (resume on
  failure).

## 3. Where humans intervene (HITL)

The runner is automatic, but **these three are always human**:
- **Outbound sends / state changes** — draft-first, only after human confirmation
  ([verification-and-guardrails](../core/verification-and-guardrails.md)).
- **Promoting received know-how** — a quarantined skill activates only when a human promotes it
  ([skills-and-mcp](skills-and-mcp.md)).
- **Resolving BLOCKED** — open questions and limit overruns are judged by a human.

## 4. Observability (what the runner leaves behind)

- Trace every transition, tool call, and gate verdict **under one correlation ID**
  ([debugging-and-dx](debugging-and-dx.md)).
- Each run gets a **reproducible trace** + cost and stage records. Regression via the golden
  tasks ([harness-acceptance](harness-acceptance.md)).

## 5. The gap from here (honest)

- **Starting point (before 2026-05-31)**: roles, forms, and gates were defined in documents and
  a human hand-chained claude 9 times to prove the flow.
- **What this spec defines**: the contract in which **the runner** does that enforcement,
  auto-insertion, and gate passage.
- **Now done (2026-05-31)**: a minimal **code runner** enforces this contract —
  [`runner/`](../runner/)'s `harness-runner.mjs` (zero dependencies) rejects via the state
  machine and the plan/completion/permission gates as deterministic code, and the full runner
  test passes **69/69** including the §7 rejection matrix
  (`node --test "harness/runner/*.test.mjs"`). The gates have risen from "instruction" to
  "code enforcement".
- **Not yet**: attaching the runner to a real orchestration runtime (process spawning, tool
  wiring) is the host's job — this runner is the gate core that judges transition admission on
  top of it.

## 6. Conformance — evidence the gates actually block

A spec *saying* "it blocks" and a gate **actually blocking** are different things. The core
gates' rejection behavior has already been confirmed by real Claude Code measurement
([harness-acceptance §7.5](harness-acceptance.md)) and is bound to the spec gates as below. So
this contract is not a hypothesis but **the codification of behavior already seen working**.

| Spec gate/contract | Required behavior | Bound measured evidence |
|---|---|---|
| Plan gate — reject incomplete slice | If any of WHAT · WHY · PASS · out-of-scope · verify command · evidence accounting · rollback, or any of the active/command/validation minute budgets is missing, or a budget exceeds the 20/12/6 caps, no advance to the next stage | G10 empty criteria → "unverifiable" **pass^5** (0 speculative passes) + runner field-by-field conformance |
| Completion gate — wrong build FAILs | An artifact violating the criteria never PASSes | G8 null build → **pass^10** FAIL · G9 correct build → pass^5 PASS |
| Outbound gate (HITL) | No automatic sends · draft-first | Permission measurement: outbound→approve · banking→refuse ([permission-matrix §4.5](../core/permission-matrix.md)) |

## 7. The conformance matrix a code runner must pass (future implementation contract)

When implementing this spec as code, prove **the rejection paths, not just the happy path**
(isomorphic to [verification-and-guardrails]'s fail-closed principle). An implementation is
recognized only when it passes all of the following rejection cases.

| Case | Input | Expected (fail-closed) |
|---|---|---|
| Stage skipping | BUILD requested without PLAN | Reject, state unchanged |
| Empty acceptance slice | Plan gate with any required field missing/blank | Transition rejected + field reason logged |
| Unbounded activation | `activeBudgetMinutes` · `commandTimeoutMinutes` · `validationMinutes` missing/non-integer/0/over 20·12·6 | Transition rejected + that budget field's reason logged |
| Unevaluated merge | DONE requested without an evaluation PASS | Reject (completion gate) |
| Self-grading | The same instance as BUILD does EVAL | Reject (maker ≠ judge) |
| Corrupted form | Status log damaged / unknown state | No progress + human intervention |
| Resume idempotency | The same transition executed twice | Side effect once only (no duplication) |

> Passing the happy path alone does not make the runner "delivered" — only when the rejection
> matrix above is all green.

## One-line summary (runner checklist)

1. Are role prompts **auto-injected** (no human attaches them)?
2. Is **gate passage enforced** at every stage transition (plan in front, completion behind)?
3. Are BUILD≠EVAL instances **forcibly separated**?
4. Are loop **hard caps** + compaction and checkpoints in place?
5. Do only outbound sends, promotion, and BLOCKED go **to a human**?
6. Is the whole flow left as a **correlation-ID trace**?

---

## Sources (basis)

- [harness-acceptance §7.5](harness-acceptance.md) (9 real Claude Code measured runs — currently a human stitches the cycle)
- [team-roles](../core/team-roles.md) · [handoff-template](../core/handoff-template.md) · [role-prompts](../core/role-prompts.md) (what gets enforced)
- [verification-and-guardrails](../core/verification-and-guardrails.md) · [loop-budget](loop-budget.md) · [debugging-and-dx](debugging-and-dx.md) (gates, limits, observability)
- Anthropic — [3-agent harness](https://www.infoq.com/news/2026/04/anthropic-three-agent-harness-ai/) (context reset + structured handoff artifacts)
