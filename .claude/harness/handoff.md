---
title: Handoff — the form a slice is carried in
audience: [AI agents]
purpose: The compact card every slice fills, and the FULL form that survives a context reset between worker and independent evaluator
updated: 2026-07-30
related: [contract.md, roles.md]
---

# Handoff

Two forms. Which one applies is decided by the risk tiering in
[`contract.md`](contract.md) §1.6 and §3.6, not by preference.

## FAST S/M — the compact card

A slice that satisfies **every** §1.6 condition creates no file. Record these seven in chat or
scratch and go. There is no independent evaluator on this path, so the result is
`review-tier: thin-review` — never `PASS`. Break any condition and escalate to the FULL form.

- **Task / goal + the missing delta:**
- **Acceptance:**
- **Scope / out of scope:**
- **Named verify command:**
- **Budget:** active ≤20 min, single command ≤12 min
- **Risk tier:** why this is FAST S/M, with the excluded boundaries checked
- **Rollback / no-op:**

## FULL — the form

One file per slice, in the slice's worktree or scratch. **Do not commit it.** Seven instances were
committed and then deleted on 2026-07-18 — not one had been referenced after its merge. The
durable record is the commit body. When delegating, **pass this file's path**: it is the only
input the context-reset next role reads.

The delegating side fills the header, acceptance and verification up front — that is the planner
inline field, not a separate pass. The worker fills only its section; the evaluator only its own.

---

## Header

- **Task:** <short and unique>
- **WHAT:** <what can the owner do once this is done>
- **WHY:** <why it is needed, and for whom>
- **Phase:** `BUILD | EVAL | DONE | BLOCKED`

## 1. Acceptance criteria

- <what must be true to pass — concrete enough for the evaluator to grade as-is>
  - [ ] <criterion>
- **Out of scope:** <the boundary. Write "none" explicitly if there is none>

## 2. Verification and recovery

- **Verification commands:** <what the evaluator re-runs unchanged>
- **Budgets:** active minutes · single-command timeout · PLAN-review passes (default 1) ·
  BUILD↔EVAL passes (default 2). Two separate counters — never borrow one for the other.
- **Progress:** `material-progress | no-progress` — material progress closes a previous blocker or
  makes acceptance measurable; no-progress is the same blocker with no new evidence.
- **Rollback:** <what to revert, what data to preserve, when to resume>

For agent/eval/replay work only, also record the evidence accounting the
[agent-testing rule](../rules/verification/agent-testing.md) defines — immutable `dataOrigin` and
independent `executionEvidence` are the two that get conflated.

## 3. Worker notes

- **Scope touched:** <files — keep narrow>
- **Per criterion:** <criterion> → <what was done>
- **Decisions and assumptions:** <the non-obvious ones, and why>
- **Verification results:** <commands run and what happened. If not run, write "not run">
- **Where the evaluator should look hardest:**

## 4. Evaluator verdict — a DIFFERENT instance from the worker

- **Verdict:** `PASS | FAIL | UNVERIFIABLE`
- **Per criterion:** <criterion> → met? <what was actually run or checked>
- **On FAIL:** <every blocker discoverable in this pass, bundled — what, why, where>
- **New-blocker provenance:** <if a later pass raised a new one, why it could not have been found
  earlier; otherwise "none">
- **Iteration:** <which BUILD↔EVAL cycle>

## Open questions — when BLOCKED

- <no answer? do not guess. Write it here and stop.>

## Status log — append only, on BLOCKED or retry

- <date · role · which budget · cumulative use · material-progress|no-progress · one line>
