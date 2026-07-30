---
title: Agent Harness — Operating Contract
audience: [AI agents]
purpose: The entrypoint that makes any agent that reads it work "the harness way" — roles, handoff, gates, and verification in one page
updated: 2026-07-30
related: [roles.md, handoff.md, dev-loop.md]
---

# Agent Harness — Operating Contract

> **This file is the entrypoint.** If you (an agent) have read this file, work by the contract below
> from now on. This one page is what makes any agent work the same way; the three sibling documents
> resolve the details. It is vendor-neutral — nothing here depends on a specific model or tool, so
> Claude Code, Codex, and any other agent read the same contract.
>
> **The harness is the control plane around the agent.** It runs the loop (plan → execute → verify),
> holds gates at each boundary, and leaves a record. **What the harness is NOT:** ① the model
> itself, and ② the **domain work** the agent produces (e.g. a backoff function) — that is workload
> passing through the harness.

## 0. The one-line principle

**Classify risk first; review FAST S/M thinly; separate FULL into roles, handoff, and independent
evaluation; and verify every path with its fail-closed gate.** When uncertain, do not guess FAST —
escalate to FULL.

## 1. How one task flows (run it exactly like this)

```
request ─▶ [RISK]
             ├─ FAST S/M ─▶ compact card ─▶ BUILD ─▶ named checks + adversarial self-check
             │                                      └─ controller diff review ─▶ thin-review
             └─ FULL ─▶ PLAN ─▶ BUILD ─▶ independent EVAL ─┬─ PASS ─▶ done
                                                            └─ FAIL ─▶ BUILD (until retry cap)
```

The FULL tier requires only two roles: the **worker** and the **independent evaluator** (§2).
PLAN and LEARN are not separate agents but **inline fields** — write WHAT+WHY+acceptance criteria
in the header before delegating, and write learnings/write-back in the commit body after completion
([muse-dev-patterns §8](../skills/muse-dev-patterns/SKILL.md)). The **full ceremony** — a separate
planner pass plus heavy multi-stage handoff — is **reserved for L-size or security-grade slices**
(§2).

- A FULL-tier task **starts by opening one handoff form** ([handoff](handoff.md)). FAST S/M fills
  only the §1.6 compact card and skips the separate file and context reset. When delegating a
  FULL-tier task, **always pass the form file's path along with it**.
- Each FULL stage fills only its own section, and the next stage receives **only that form** as
  input (context reset).
- Every arrow between stages passes through a **gate** before the next stage begins (§3).

## 1.5 Choose the orchestration mode first

For any non-trivial task, pick a **mode** before starting:

- **Just work** — trivial, single-step, strictly sequential, same-file edits, routine.
- **Subagents** — noise isolation, "do and report" repetition, and the independent verdict.
- **Agent team** — workers that collaborate, challenge each other, and exchange results in parallel.
- **Workflow** — deterministic, repetitive, large-scale multi-step work (codebase sweeps, mass
  migrations).

The default is a **single session**. Go multi only when the work decomposes into independent
threads (multi-agent costs 4–15× tokens). **Whatever the mode, the role, gate, handoff, and
verification contract below applies unchanged.**

## 1.6 FAST S/M — the default fast path for safe internal work

A task is FAST S/M only when **all** of the following hold:

- Active work fits in 20 minutes and touches at most 3 directly-owned files in one package.
- It is a deterministic local contract, and reverting that diff alone recovers from failure.
- It touches none of: user-visible strings/i18n, public API/CLI/UI contracts, persisted
  formats/migrations/credentials, security/permission/guard, external effects,
  browser/computer/audio, process/scheduler/concurrency, harness gates, release.

FAST S/M creates no separate handoff file, no planner, no fresh evaluator context. Before working,
fill the compact card below; the worker runs the named tests plus the affected typecheck/lint and
an explicit adversarial self-check; then the **controller/lead** (default: the current session that
activated the task) skims the current diff and records `review-tier: thin-review`. In FAST the
controller/lead may be the same as the worker, but this is **never called an independent PASS**.
If scope grows, an excluded boundary above is discovered, or one BUILD↔review round makes no
material progress, escalate to the FULL tier immediately.

`Task/goal+missing delta · acceptance · scope/out-of-scope · named verify command · active/command timeout ·
risk tier · rollback/no-op`

## 2. Roles — 2 mandatory + inline fields + optional

The FULL tier requires exactly two roles: the **worker** and the **independent evaluator**. In FULL,
**maker ≠ judge always holds** — if there is no way to spawn a separate instance (pure single
session): run the evaluation in a **fresh context whose only input is the handoff form** — a new
session/conversation with zero build-conversation history; a "second look" inside the same session
does not qualify. If even that is impossible, a self-graded PASS is void — record "unseparated
self-evaluation" in the evaluation section and request human review.

| Role | Mandatory? | Job |
|---|---|---|
| Worker (builder) | **Mandatory** | Receives WHAT+WHY+acceptance criteria and produces the artifact |
| Independent evaluator | **Mandatory in FULL** | Independent verdict (PASS/FAIL + evidence) from a **different instance** |
| Planner | Inline field | Writes WHAT+WHY+acceptance criteria in the header before delegation (not a separate pass) |
| Curator/learner | Inline field | Writes learnings/write-back in the commit body after completion |
| Orchestrator | Optional (L-size) | Owns context and plan, delegates to multiple workers, synthesizes |
| Reviewer | Optional (security-grade) | Full-context risk review before merge |

**Only one of these ships as a subagent file**:
[`.claude/agents/independent-evaluator.md`](../agents/independent-evaluator.md). Planner and
curator are inline fields, so a dedicated subagent for either would contradict this section; the
worker is the session doing the work, which already has this contract in context. Do not re-add a
`planner`/`worker`/`curator` agent file — the three that existed were never once invoked, and a
`planner` is also confusable with the host's built-in `Plan` agent.

The full ceremony (separate planner pass + heavy multi-stage handoff) is **reserved for L-size or
security-grade slices**. Details and the onboarding checklist for a new agent: [roles](roles.md).

## 3. Gates (fail-closed — this is the core safety mechanism)

- **Plan gate (front)** — refuse BUILD entry if acceptance criteria are empty or contradictory.
  For FAST, the controller/lead admits the task when every §1.6 condition is mechanically satisfied
  and the compact card is complete and consistent; when uncertain, escalate to FULL. In FULL the
  gate is judged by the **orchestrator or the evaluator** — the planner never passes its own plan.
- **Completion gate (back)** — FULL is not done without an evaluator PASS (+ automated grading
  where possible). FAST S/M completes as `thin-review` only with named verification + adversarial
  self-check + controller diff review, all present.
- **Permission gate** — classify tools by risk tier (read/write/execute/outbound/forbidden);
  outbound is **auto-forbidden, draft-first, human-confirmed**; finance/payments are permanently
  refused. The only exception: a normal Git push under a standing authorization the project owner
  has recorded in versioned host rules — with destination, verification, and failure limits
  narrowed — counts as pre-approved within that scope.
  → [outbound-safety](../rules/safety/outbound-safety.md) · [commits](../rules/engineering/commits.md).
- **Blocked-first** — when uncertain or ambiguous, do not pass; stop and escalate to a human.

How each gate is proven, and how the judge itself is calibrated:
[agent-testing](../rules/verification/agent-testing.md).

## 3.5 Distinguish the two layers — advisory vs enforced

The harness operates in two layers:

- **Advisory layer (Guides)** — this contract, the role prompts, the handoff form. Steering input
  the model *chooses to follow*. For an interactive session — the usual case, where Claude Code or
  Codex reads this file — this layer alone makes the harness complete.
- **Enforced layer (Sensors/Gates)** — the versioned pre-push hook, lint, typecheck, and the test
  and eval suites. Deterministic code the model cannot talk its way around. When the same rule is
  violated repeatedly (in practice **3–4 times**), **promote** it from advisory to this layer by
  writing a gate that fails closed, and lock it with a test that reddens when the code breaks.

The enforced layer is what survives a headless run, where an instruction enforces nothing. Any
autonomous loop therefore has to land on a real gate, never on a promise in prose.

## 3.6 When the evaluator is mandatory — risk tiering

An independent evaluator (separate instance) is **unconditionally required** when the diff touches
any of: user-visible strings/i18n, on-disk/persisted formats (stores, checkpoints, credentials),
advertised public flags/CLI/API/UI contracts, security/permission/guard/outbound paths,
process/scheduler/concurrency, harness gates, anything irreversible, release. For internal
refactors, type plumbing, and pure test changes that satisfy all of §1.6, a thinner tier is
enough: the worker runs an explicit adversarial self-check ("find an input where this is wrong")
and the controller/lead skims the diff. **Always record which tier was used in the commit body** —
this is not optional ceremony. The independent evaluator is a real cost (a second full-context
pass) — spend it where it pays. Evidence: in one session, all 4 real evaluator catches were
**silent-failure classes** (data corruption, a dead locale string, a lying flag, a timing bug) —
exactly the class a green test suite does not surface.

## 3.7 PLAN review and BUILD↔EVAL are separate budgets

Do not merge the PLAN-review budget and the post-implementation BUILD↔EVAL repair budget into one
counter. In PLAN, never escalate a task to `BLOCKED` on the raw `PLAN FAIL` count alone.
**Material progress** is a change that closes a previous blocker or makes acceptance
criteria/accounting measurable; **no-progress** is the same blocker repeating with no new evidence
or fix. PLAN escalates to `BLOCKED` only on confirmed no-progress or on reaching the time/cost cap
declared in the header.

BUILD↔EVAL has its own iteration/time/cost caps, separate from PLAN. The evaluator returns
**blockers bundled — everything reasonably discoverable in one pass**. If a later pass raises a
new blocker, record why it could not have been found earlier (did a prior fix open a new path; did
required evidence appear late). Concrete accounting fields: [handoff](handoff.md); termination judgment for an
unattended loop: [loop-engineering](../skills/loop-creator/references/loop-engineering.md) §1.5.

The volume of evaluation data is separate from evidence quality. More synthetic
families/profiles/journeys/turns or controlled replay never becomes organic user evidence or an
agent PASS. `realismProxy` is only the name of deterministic transition coverage, not a proof of
realism. Account the immutable `dataOrigin` (provenance) and `executionEvidence` (did it actually
run) as independent axes, and never convert a factual interaction receipt into
feedback/outcome/policy promotion.

## 4. Foundations (progressive disclosure)

Every task reads only this entrypoint plus the surface documents it selected. Read further only
when the task actually touches that risk or feature.

- **Loop caps** — declare hard caps on iterations, time, and cost; any one reached ends the
  run and records which. The BUILD↔EVAL default is **2 retry passes** — a contract default, not a
  value read from code, so a loop that needs it enforced writes its own cap and a test for it. An
  unattended loop fire may declare up to 3 and must record which it used
  (→ [loop-engineering](../skills/loop-creator/references/loop-engineering.md) §1.5).
- **Tools, skills, MCP** — names/schemas selectable in one shot; allowlists and isolation.
  → [tool-calling](../rules/safety/tool-calling.md) ·
  [skills-and-mcp](../skills/loop-creator/references/skills-and-mcp.md).
- **Verification technique** — which gate proves what, and how the agent itself is evaluated.
  → [testing](../rules/verification/testing.md) · [agent-testing](../rules/verification/agent-testing.md).
- **Ratchet & pruning** — every rule line comes from one observed failure (failure → one advisory
  line → promoted to a gate when it repeats), and a rule that no longer carries load as models
  improve gets **deleted**, not archived. A contract that only grows stops being read.

## 5. Verification (does it really work — unverified means not done)

- **"Done" for an individual task is judged by the §3 completion gate** (FULL: independent PASS;
  FAST S/M: `thin-review`; both actually execute the named verification method).
- Grade the **outcome** — the resulting state and final answer — not the exact path the agent took.
  Pin a step order only where a step genuinely depends on a prior one.
- For a grounding- or safety-critical case, reliability is **pass^k**: run the same case k times
  and require **all k** to pass. "Succeeded at least once" (`pass@k`) is not reliability.
- A gate that skips is not a gate that passed. Record the skip as unverified and fix the
  environment; that repair is itself the work.

Which command proves what: [testing](../rules/verification/testing.md). How to evaluate the agent
rather than the code: [agent-testing](../rules/verification/agent-testing.md).

## 6. Adapting to this project

The day-to-day loop this contract drives — how a slice is chosen, built, and verified in this
repository — is [dev-loop](dev-loop.md). Project-wide invariants that outrank anything here live in
[CLAUDE.md](../../CLAUDE.md) and [`.claude/rules/`](../rules/).

## 7. Model-specific calibration (the ONLY model-named section — everything else is vendor-neutral)

Everything above is model-agnostic. This section pins how to calibrate the harness to the current
frontier models (2026-07-30, from Anthropic's Claude Opus 5 prompting guide and the Claude 5 /
GPT-5.6 family guidance); re-audit it on every model upgrade (§4 ratchet & pruning).

- **Do not add model self-verification steps.** Current frontier models (Claude Opus 5 and peers)
  verify their own work unprompted. Instructions like "include a final verification step",
  "double-check your answer", "re-verify before responding", or "use a subagent to verify your own
  output" now make output *worse*: they compound into over-verification that burns tokens for no
  quality gain — Anthropic explicitly names "legacy harness scaffolding that adds separate
  verification steps" as the failure. **This does NOT touch two other things this harness runs
  on:** ① deterministic gates (tests, lint, typecheck, pass^k) are programs, not model self-checks
  — keep them all; ② the **independent evaluator** (§3.6) is a *different* instance with a fresh
  context judging a finished build against acceptance criteria — that is not self-verification, and
  its recorded catches (4/4 silent-failure classes) justify its cost at the §3.6 risk tiers.
- **Delegation posture differs per model — state which applies.**
  - *Claude Opus 5*: delegates readily and must be **capped** — delegate only large, genuinely
    independent, parallelizable tracks; never work finishable in a handful of tool calls; never a
    subagent to verify your own output; prefer one subagent over several; keep spawn counts low.
  - *Claude Fable 5*: the opposite — delegate freely and keep subagents **long-lived across
    subtasks** instead of respawning per step.
- **Long autonomous runs (Fable 5)** need three things this harness already encodes — wire them,
  don't improvise: explicit **stopping points** (destructive actions, scope changes, decisions
  that belong to the human → the §3 permission gate and blocked-first rule), a **learning
  repository** where each run's lessons land (→ curator write-back, commit body), and the **why**
  of the work stated up front (→ the WHY field in the handoff header).
- **Effort levels** (cost lever, host maps these in its adapter): Claude Opus 5 — use low/medium
  liberally as the main cost lever, xhigh only for the hardest coding/agentic work. Claude
  Fable 5 — high for everyday work, xhigh for the hardest. GPT-5.6 — Luna for low-risk repeatable
  transformation, Terra for everyday implementation, Sol for complex refactors, architecture,
  security, and release decisions (this is the `Sol/high`/`Sol/xhigh` gate-strength shorthand in
  [roles §1.5](roles.md)).
- **A rule in a document is followed unreliably — a gate is not.** The limit is not how many
  rules a model can hold; it is whether policy stored *away from the request* survives a
  multi-step task. On HANDBOOK.md, built for exactly that setup, the best frontier configuration
  scores **36.2% strict pass@1** and most score **under 25%**
  ([arXiv 2607.25398](https://arxiv.org/abs/2607.25398)); its named failure modes are overriding
  policy for a plausible-sounding request, running the required check and then ignoring its
  result, and reporting compliance that did not happen. Robustness also does not transfer between
  surfaces — a model that holds a rule against a direct contradiction can still lose it when the
  contradiction arrives inside tool output (**20.5–98.2%** across 37 models,
  [arXiv 2607.25987](https://arxiv.org/abs/2607.25987)). So: prefer deleting a rule, or promoting
  it to a gate that fails closed, over writing a longer contract — and never treat a line here as
  protection for a safety-critical path.
- **Prune this contract by ablation, not by intuition.** When a model upgrade lands, the question
  for each line is not "is it still true" but "does removing it change what the agent does".
  Anthropic's own guidance for the current generation is that scaffolding built for weaker models
  now costs quality; the method that finds it is deleting a section and checking whether any gate
  or observed behavior actually moves.

---

> Summary: **if you read this, follow it.** Classify risk first → FAST via compact card and
> `thin-review`, FULL via roles, form, and independent evaluation → actually verify the relevant
> gate. The links above resolve the details.
