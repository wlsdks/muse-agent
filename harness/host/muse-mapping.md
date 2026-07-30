---
title: Harness ↔ Muse Runtime Mapping
audience: [developers, AI agents]
purpose: Connect the abstract harness roles to the real multi-agent runtime parts Muse already has
status: draft
updated: 2026-07-17
related: [../core/team-roles.md, ../core/role-prompts.md, ../core/handoff-template.md, ../README.md]
---

# Harness ↔ Muse Runtime Mapping

> **Why is this needed?** [team-roles](../core/team-roles.md) ·
> [role-prompts](../core/role-prompts.md) · [handoff-template](../core/handoff-template.md) are
> the vendor-neutral "ideal team". But Muse **already has a multi-agent runtime.** This document
> honestly pins down which real Muse part each abstract role engages with — and therefore what is
> possible right now versus what is still at the form (document) stage. (The code was verified
> directly in the codebase; here it is carried over in prose only.)

> The contract **requires** only two roles: worker and independent evaluator
> ([team-roles §1](../core/team-roles.md)). The table below maps those two plus the optional
> extension roles usable on L-size slices — orchestrator/curator and the like — to where they
> already exist in the Muse runtime.

## Role → Muse part mapping

| Harness role | Part Muse already has | Status |
|---|---|---|
| Orchestrator / supervisor | A **supervisor** + orchestrator runtime that distributes work across workers and synthesizes results. Carries limits like minimum confidence and maximum handoff count. | ✅ runtime exists |
| Worker / generator | Registered **worker agents** — the supervisor picks and runs them. | ✅ runtime exists |
| Shape of work (sequential/parallel/race) | Orchestration actually supports **sequential, parallel, and race (first-to-finish wins)** modes. | ✅ runtime exists |
| Agent specs | An **agent-spec registry** with roles, tools, and instructions — the fitting one is picked per request. | ✅ runtime exists |
| Direct agent-to-agent messages | Workers exchange with each other/the supervisor over an in-memory **message bus**. | ✅ runtime exists |
| Model tiering | Within one task, simple work is **automatically routed** to a fast model and deep reasoning to a strong one. | ✅ runtime exists |
| History & observability | A **history store** recording each orchestration's mode, duration, and success/failure counts. | ✅ runtime exists |
| Evaluator (maker ≠ judge) | `.claude/agents/harness-evaluator.md` — an independent subagent with no write tools (separation enforced via tool permissions) + calibration n=12 TPR/TNR 100% ([judge-calibration](../reference/judge-calibration.md)). | ✅ exists |
| Curator/learner (learning from tasks) | **Real** — skill self-authoring and tidying (archive/consolidate), playbook reward/decay (reinforce strategies that worked, weaken corrected ones), and retrospective synthesis exist in the runtime. Received skills are quarantined before human promotion. | ✅ runtime exists |
| Handoff artifact (context reset) | The single form ([handoff-template](../core/handoff-template.md)) + the runner rejecting corrupted forms and stage-skipping in code ([runner-spec §7](../reference/runner-spec.md)). | ✅ code-enforced |
| Verification gates (completion hooks · checkpoints) | [runner/](../runner/)'s `orchestrator.mjs` (automatic driving), `hooks.mjs` (PreToolUse blocking), `session.mjs` (checkpoint resume) — suite 69/69. | ✅ code-enforced |
| Agent-eval evidence | Per-attempt setup/teardown and local JSONL in `scripts/eval-harness.mjs`, human-reviewed redacted case promotion and per-case delta in `eval:evidence`, strict `pass^k`; offline CI and local live models kept separate. | ✅ code-enforced |

## So what is possible right now

- **Possible immediately**: the supervisor runs workers sequentially/in parallel/in race mode,
  picks the fitting worker by spec, exchanges over the message bus, saves cost via model tiering,
  and observes via history — the Muse runtime already does this flow. That is, the harness's
  **orchestrator-workers + shape-of-work + delegation/messaging** axes are real.
- **Filled in since (2026-05-31~)**: the independent evaluator (a subagent with no write
  permission), code enforcement of the handoff form, and automatic execution of the verification
  gates (the runner) — the three things once called "the last gap" are all closed by
  [runner/](../runner/) and `.claude/agents/`
  ([harness-acceptance §7.5](../reference/harness-acceptance.md)).
- **Agent-eval P0 (2026-07-17)**: deterministic contracts run on both-OS CI via
  `eval:agent:offline`, and live model evaluation is split off to local/self-hosted. Privacy-safe
  JSONL is written only when `MUSE_EVAL_RESULTS_DIR` or `artifact.resultsDir` is explicit, and
  neither a skip nor an artifact failure is turned green. The first real application is
  `eval:adversarial`'s secret-persistence store isolation. In a deterministic measurement with
  Ollama off, 25 cases × strict 3 runs = 75/75 attempts passed; the JSONL held 75 trials + 1
  summary, POSIX files/directories were `0600`/`0700`, and scratch residue after exit was 0.
- **Agent-eval P1 first slice (2026-07-17)**: `eval:evidence` accepts only a complete P0 artifact,
  candidates terminal fails, and mints `muse.eval.case/v1` only after an exact candidate-bound
  redaction review. It never reads raw trace refs; baseline/current are compared per composite
  case key as improved/regressed/new/unverified, and the delta fail-closes on any current failure,
  regression, omission, or safety floor. Evidence output is restricted to POSIX `0600` and a
  Windows protected owner-only ACL.

## Honest gaps (what remains)

1. Measured multi-stage work at large **real-codebase scale** (so far centered on small-to-medium
   tasks).
2. Judge calibration set: **expand n + repeat** (currently n=12, measured once).

> This mapping is grounded in code facts (verified directly). When the runtime changes, update the
> status (✅/⚙️) in the table above. The feature-level description is SYSTEM-MAP #11; role
> definitions are [team-roles](../core/team-roles.md).
