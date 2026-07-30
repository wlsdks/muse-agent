---
title: Handoff Artifact
audience: [developers, AI agents]
purpose: The single form through which, on the FULL tier, worker → independent evaluator exchange a "defined state" across the context reset
status: draft
updated: 2026-07-30
related: [team-roles.md, role-prompts.md, ../README.md]
---

# Handoff Artifact

## FAST S/M compact card

A task that satisfies **all** conditions of [`../AGENTS.md` §1.6](../AGENTS.md) creates no separate
handoff file; record only the 7 items below in chat/scratch. This path has no independent
evaluator, so the result is `review-tier: thin-review`, not `PASS`. If any condition is broken,
escalate to the FULL form below.

- **Task / goal + missing delta:**
- **Acceptance:**
- **Scope / out-of-scope:**
- **Named verify command:**
- **Budget:** active ≤20 min, command timeout ≤12 min
- **Risk tier:** why this is FAST S/M, with the exclusion boundaries checked
- **Rollback / no-op:**

> **Why is this the skeleton?** The harness runs the same way "whichever agent comes in" because
> **context is cut, not merged, and the next role picks up from a defined state via a structured
> artifact** ([team-roles §3](team-roles.md)). This file is the **single form** for FULL-tier
> artifacts — fill one copy per task and pass it on. Every handoff starts from reading this
> document, not "the previous agent's head".
>
> **The default is only these 5 sections (below).** Since the mandatory roles shrank to worker +
> independent evaluator ([team-roles §1](team-roles.md)), there is no separate planner pass and no
> review/learning section in the default form — PLAN goes in the "Header" section below, and LEARN
> goes in the **commit body** after completion per
> [muse-dev-patterns §8](../../.claude/skills/muse-dev-patterns/SKILL.md). **The full ceremony
> (separate planner pass + the review and learning sections of a heavy multi-stage handoff) is for
> L-size or security-grade slices only** — in that case append the "Appendix: full ceremony"
> section at the end of this document.

## How to use

1. For each FULL-tier task (feature/bug/slice), copy this form into one file — **a working file,
   not a permanent record**: keep it in the slice's worktree (or scratchpad) and **do not commit
   it to the repo**. The permanent record is the commit body (acceptance criteria, verification
   results, learnings — [muse-dev-patterns §8](../../.claude/skills/muse-dev-patterns/SKILL.md)).
   The 7 previously committed instances were deleted (2026-07-18 — never once referenced after
   merge, so the committing practice itself was stopped; git history preserves them). **When
   delegating, always pass this file's path along** — it is the only input the context-reset next
   role will read.
2. The delegating side (orchestrator or the worker itself; no separate planner unless L-size)
   fills **header + acceptance criteria + verification method** first. The worker fills only its
   section; the evaluator only its section (boundaries).
3. The next role starts from this document + the code only. If stuck, write it under
   `## Open questions` and stop (no guessing).
4. Status accumulates one line at a time in `## Status log` (who, when, what). Keep it revertible.

---

## Header (goal + context)

- **Task name:** <short and unique>
- **One-line goal (WHAT / `what`):** <what can the user do once this task is done>
- **Product context (WHY / `why`):** <why this is needed, who it is for>
- **Current phase:** `BUILD | EVAL | DONE | BLOCKED`
- **Owner (current):** <role/agent>

## 1. Acceptance criteria (PASS / `passCriteria`)

- <"what must be true to pass" — concrete, verifiable, as a checklist>
  - [ ] <criterion 1>
  - [ ] <criterion 2>
- **Out of scope (`outOfScope`):** <the boundary of what will not be done. Write "none" explicitly
  if none>

## 2. Verification, evidence, recovery

- **Verification commands (`verificationCommands`):** <commands/observations the evaluator re-runs
  as-is>
- **Active budget (`activeBudgetMinutes`):** <positive integer, max 20>
- **Single-command timeout (`commandTimeoutMinutes`):** <positive integer, max 12>
- **Validation budget (`validationMinutes`):** <positive integer, max 6>
- **PLAN-review budget:** <default 1 pass / within the active budget; override only when a
  different cap is needed>
- **BUILD↔EVAL budget:** <default 2 passes / within the active budget; override only when a
  different cap is needed>
- **Progress judgment:** `material-progress | no-progress` — material progress is a change that
  closes a previous blocker or makes acceptance/accounting measurable; no-progress is the same
  blocker repeating with no new evidence or fix
- **Evidence accounting (`evidenceAccounting`, agent/eval/replay/policy work only):** <semantic
  family / surface variant / profile / journey / turn counts; the `realismProxy` name; immutable
  `dataOrigin`; independent `executionEvidence`; controlled replay / organic production evidence;
  receipts kept separate from feedback>
- **Rollback / recovery (`rollback`):** <what to revert on failure/regression, what data to
  preserve, resume conditions>

## 3. Worker notes (filled by the worker/builder)

- **Scope touched:** <files/modules — keep narrow>
- **What was done:** one line per acceptance criterion
  - <criterion 1> → <what was done>
- **Decisions/assumptions:** <non-obvious choices and why>
- **Verification run results:** <commands run + results. If not run, write "not run">
- **Where the evaluator should look hardest:** <handed to the next role>

## 4. Evaluator verdict (filled by the independent evaluator — MUST be a different agent than the worker)

- **Verdict:** `PASS | FAIL`
- **Criteria check:** for each criterion in §1, met/not met + evidence
  - <criterion 1> → met? <evidence (what was actually run or checked)>
- **Concrete feedback (on FAIL, so the worker can fix immediately):**
  - <bundle the blockers reasonably discoverable in one pass: what is wrong, why, and where>
- **New-blocker provenance:** <if a later pass raised a new blocker, why it could not have been
  found in the earlier pass; otherwise "none">
- **Iteration count:** <which BUILD↔EVAL cycle this is>

---

## Open questions (when BLOCKED)

- <if there is no answer, do not guess — write it here and stop; a human/orchestrator resolves it>

## Status log (append-only; only on BLOCKED or retry)

- <YYYY-MM-DD HH:MM> · <role> · <PLAN-review | BUILD↔EVAL> · <cumulative budget> ·
  <material-progress | no-progress> · <one line: blocker closed / new evidence>

---

## Appendix: full ceremony (L-size · security-grade slices only)

Only large work where the default 5 sections are not enough (multiple workers, human merge
approval required, high-regression-risk security/persisted-format changes) appends the two
sections below. Not used on ordinary slices.

### Appendix A. Merge review (reviewer/human)

- **Pre-merge check:** <risks seen in full context>
- **Approval:** <who, when>

### Appendix B. Learning (default is the commit body — use this only to collect multiple workers' learnings in one place)

- **Strategies that worked (reinforce):** <use more often next time>
- **Corrections/failures (weaken/ratchet):** <strategies to weaken / failures to pin as a one-line
  rule>
- **Reusable procedure:** <skill/procedure extracted from this task — "none" if none>

---

> Rule: this form interlocks 1:1 with the roles and gates in [team-roles](team-roles.md). If the
> form changes, update there too. Per the compressed-return / external-file principle
> ([team-roles §3](team-roles.md)), point to links instead of inlining anything large.
