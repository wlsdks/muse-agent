---
title: Agent Harness — Operating Contract
audience: [AI agents, developers, planners]
purpose: The entrypoint that makes any agent that reads it work "the harness way" — roles, handoff, gates, and verification enforced in one page
format: AGENTS.md (vendor-neutral, readable by any agent/tool)
updated: 2026-07-30
---

# Agent Harness — Operating Contract

> **This file is the entrypoint.** If you (an agent) have read this file, work by the contract below
> from now on. This one page is what makes any agent work the same way, and the documents in this
> folder resolve the details. **This folder IS the harness — copy it into any project and that
> project's agents operate this way.**
>
> **The harness is the execution infrastructure (control plane) around the agent — it *executes*,
> not just instructs.** It runs the loop (plan → execute → verify), enforces gates at runtime,
> executes tools, and leaves traces (2026 consensus: Claude Code's five layers · OpenAI Harness
> Engineering · control-plane essays). **What the harness is NOT:** ① the model itself, and ② the
> **domain/app work** the agent produces (e.g. a backoff function) — that is workload passing
> through the harness. The gate/loop code in `runner/` is harness proper; the functions produced
> inside it are workload.

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
([muse-dev-patterns §8](../.claude/skills/muse-dev-patterns/SKILL.md)). The **full ceremony** —
a separate planner pass plus heavy multi-stage handoff — is **reserved for L-size or
security-grade slices** (§2).

- A FULL-tier task **starts by opening one handoff form** ([handoff-template](core/handoff-template.md)).
  FAST S/M fills only the §1.6 compact card and skips the separate file and context reset. When
  delegating a FULL-tier task, **always pass the form file's path along with it**.
- Each FULL stage fills only its own section, and the next stage receives **only that form** as
  input (context reset).
- Every arrow between stages passes through a **gate** before the next stage begins (§3).

## 1.5 Choose the orchestration mode first

For any non-trivial task, pick a **mode** before starting (situation table and evidence:
[claude-code-integration §8](reference/claude-code-integration.md)):

- **Just work** — trivial, single-step, strictly sequential, same-file edits, routine.
- **Subagents** (`.claude/agents/harness-*`) — noise isolation, "do and report" repetition.
- **Agent team** — workers that collaborate, challenge each other, and exchange results in parallel.
- **Workflow** (Dynamic Workflows) — deterministic, repetitive, large-scale multi-step work
  (codebase sweeps, mass migrations).

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

| Role | Mandatory? | Job | Prompt |
|---|---|---|---|
| Worker (builder) | **Mandatory** | Receives WHAT+WHY+acceptance criteria and produces the artifact | [role-prompts](core/role-prompts.md) |
| Independent evaluator | **Mandatory in FULL** | Independent verdict (PASS/FAIL + evidence) from a **different instance** | 〃 |
| Planner | Inline field | Writes WHAT+WHY+acceptance criteria in the header before delegation (not a separate pass) | 〃 |
| Curator/learner | Inline field | Writes learnings/write-back in the commit body after completion (§muse-dev-patterns §8) | 〃 |
| Orchestrator | Optional (L-size) | Owns context and plan, delegates to multiple workers, synthesizes | 〃 |
| Reviewer | Optional (security-grade) | Full-context risk review before merge | 〃 |

The full ceremony (separate planner pass + heavy multi-stage handoff) is **reserved for L-size or
security-grade slices**. Details: [team-roles](core/team-roles.md). Onboarding checklist for a new
agent: [team-roles §7](core/team-roles.md).

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
  narrowed — counts as pre-approved within that scope. → [permission-matrix](core/permission-matrix.md).
- **Blocked-first** — when uncertain or ambiguous, do not pass; stop and escalate to a human.

Gate definitions and pass conditions: [verification-and-guardrails](core/verification-and-guardrails.md).

## 3.5 Distinguish the two layers — advisory vs enforced

The harness operates in two layers (2026 consensus: the Claude Code gate ladder "instructions are
advisory, hooks are guarantees" · Thoughtworks "Guides & Sensors"):

- **Advisory layer (Guides)** — this folder's md contracts, role prompts, handoff form. Steering
  input the model *chooses to follow*. **For interactive sessions (the usual case where Claude
  Code/Codex reads this file), this layer alone makes the harness complete.**
- **Enforced layer (Sensors/Gates)** — hooks, lint, tests, the [runner/](runner/) gates.
  Deterministic code the model cannot talk its way around. When the same rule is violated
  repeatedly (in practice **3–4 times** — Cherny: automate it as lint/hooks at that point),
  **promote** it from advisory to this layer.

**The runner is not a prerequisite of the harness.** The runner is *required* in exactly three
places: ① headless automation (`claude -p` cycles — where instructions enforce nothing) ② proving
by test that a gate really fails closed ③ porting to another agent CLI.

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
required evidence appear late). Concrete accounting fields:
[handoff-template](core/handoff-template.md); termination judgment: [loop-budget](reference/loop-budget.md).

The volume of evaluation data is separate from evidence quality. More synthetic
families/profiles/journeys/turns or controlled replay never becomes organic user evidence or an
agent PASS. `realismProxy` is only the name of deterministic transition coverage, not a proof of
realism. Account the immutable `dataOrigin` (provenance) and `executionEvidence` (did it actually
run) as independent axes, and never convert a factual interaction receipt into
feedback/outcome/policy promotion.

## 4. Foundations (progressive disclosure)

Every task reads only this entrypoint plus the surface documents it selected. The references below
are read additionally only when the task actually touches that risk/feature. `golden-set`,
`pass^k`, the runner spec, and the full architecture/observability documents are for
harness/runtime/eval slices and phase gates — not prerequisite reading for ordinary FAST S/M.

- **Loop caps** — hard caps on iterations, time, and budget. The BUILD↔EVAL default is **2 retry
  passes** (`maxRetries = 2` in `runner/orchestrator.mjs`), overridable within the active budget.
  → [loop-budget](reference/loop-budget.md).
- **Memory** — store only durable facts long-term, drop one-offs, hold weak inferences. → [memory-layers](reference/memory-layers.md).
- **Compaction** — reduce pre-emptively and periodically before the limit, but **preserve decisions and sources**. → [context-compaction](reference/context-compaction.md).
- **Tools, skills, MCP** — names/schemas selectable in one shot; allowlists and isolation. → [tool-design](reference/tool-design.md) · [skills-and-mcp](reference/skills-and-mcp.md).
- **Observability & recovery** — correlation-ID traces end to end, checkpoint resume. → [failure-modes-and-observability](reference/failure-modes-and-observability.md) · [debugging-and-dx](reference/debugging-and-dx.md).
- **Ratchet & pruning** — every rule line comes from one observed failure (failure → one advisory
  line → promoted to hook/code when repeated), and components that no longer carry load as models
  improve get deleted. → [architecture §5](reference/architecture.md).

## 5. Verification (does it really work — unverified means not done)

- **"Done" for an individual task is judged by the §3 completion gate** (FULL: independent PASS;
  FAST S/M: `thin-review`; both actually execute the named verification method).
  The golden set and pass^k below verify the *harness itself* — they are not required per task.
- Grade a representative task bundle ([golden-set](reference/golden-set.md)) on outcome+path, and
  run the same task repeatedly for **pass^k** (passes every time) to confirm tolerance to
  non-determinism. (In a minimal install without reference/, keep the essence: grade the
  *outcomes* of a few representative tasks drawn from real use, and treat safety-critical checks
  as all-pass over repeats.)
- The harness's own acceptance contract is [harness-acceptance](reference/harness-acceptance.md).
  The runner contract that enforces gates as code is [runner-spec](reference/runner-spec.md).

## 6. Adapting to this project

How the abstract roles connect to a real project runtime lives in one adapter document — example:
[muse-mapping](host/muse-mapping.md). **When installing in a new project, clone that file and
rewrite it as your project's mapping.** (Installation: [INSTALL](INSTALL.md).)

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
  on:** ① deterministic gates (tests, lint, typecheck, runner gates, pass^k) are programs, not
  model self-checks — keep them all; ② the **independent evaluator** (§3.6) is a *different*
  instance with a fresh context judging a finished build against acceptance criteria — that is not
  self-verification, and its recorded catches (4/4 silent-failure classes) justify its cost at the
  §3.6 risk tiers.
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
  [team-roles §1.5](core/team-roles.md)).
- **Instruction budget.** Frontier models reliably follow ~150–200 discrete instructions, and the
  host system prompt already consumes ~50. Past that, models ignore instructions wholesale rather
  than filtering — keep this entrypoint short and rely on §4 progressive disclosure.

---

> Summary: **if you read this, follow it.** Classify risk first → FAST via compact card and
> `thin-review`, FULL via roles, form, and independent evaluation → actually verify the relevant
> gate. The links above resolve the details; [INSTALL](INSTALL.md) resolves installation.
