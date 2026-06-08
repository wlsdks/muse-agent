---
name: improve-muse
description: Use when beginning a Muse development session, deciding what to build or improve next, or finishing one slice and wanting the next — anytime you would otherwise hand-write a "what should I work on" prompt for the Muse repo. Muse-specific; the daily dev entrypoint.
---

# improve-muse

## Overview

One invocation runs **one verified development slice** over Muse's existing
harness, and **finds the work itself** — so you never hand-write "what should I
build" again. Call it again after each slice: it compounds (every fire leaves the
backlog, golden suite, and rules richer, so the next fire is strictly cheaper).

This skill is the thin RUNNER. The contract it executes is
**[`harness/dev-loop.md`](../../../harness/dev-loop.md)** — read it first; it
holds the principles, the canon, the full loop, and the anti-patterns. Other
load-bearing files: [`docs/goals/backlog.md`](../../../docs/goals/backlog.md)
(the work source), [`harness/AGENTS.md`](../../../harness/AGENTS.md) (roles +
handoff for the non-trivial path), [`docs/EXPANSION-PLAYBOOK.md`](../../../docs/EXPANSION-PLAYBOOK.md)
(gap-finding when the backlog is thin).

## The loop (one fire — depth in dev-loop.md §3)

0. **PRE-FLIGHT** — `curl -s localhost:11434/api/tags` (Ollama up?); `git fetch`
   (reconcile the auto-pushing loop); rebuild touched dep packages (stale dist
   masquerades as a bug).
1. **ORIENT (regression-first)** — `pnpm self-eval`. A dropped gate IS the fire:
   fix it and stop. (Must be green plumbing — see Common Mistakes.)
2. **FIND WORK (autonomous — never ask the human)** — (a) regression → that.
   (b) else the top `★ OPEN` item in `docs/goals/backlog.md` — and among
   `★ OPEN`, a declared PREREQUISITE outranks the feature it unblocks. (c) else run
   EXPANSION-PLAYBOOK gap-finding (scout subagents) and WRITE the candidates back
   to the backlog. (d) once ~20-30 labeled trace failures exist, error-analysis
   outranks (b). The DATA/backlog picks — you do not prompt for direction.
3. **PLAN** — WHAT + WHY + the gate it strengthens, one line into
   `harness/handoff-template.md`. Trivial slice → skip (self-gate below).
4. **BUILD** — one vertical slice, smallest scope, deterministic code (not
   prompt). Strengthen exactly one gate or add one verb_noun tool.
5. **VERIFY (fail-closed)** — map the diff → the exact eval/smoke subset + run
   invariants (fabrication=0 on real traces too, lint 0/0, changed-package test,
   `pnpm check` if cross-package). pass^k k≥3 for grounding/safety. Independent
   `harness-evaluator` subagent (no write tools) + `eval:judge` meta-eval. No
   green → not done.
6. **WRITE-BACK (completion gate — cannot declare done without all four)** —
   (a) the fixed miss → a STABLE-3/3 golden case; (b) any recurring correction →
   one line in the matching `.claude/rules/*.md`; (c) chosen + rejected direction
   + source URL → `backlog.md`, durable fact → MEMORY.md; (d) before→after →
   self-eval scoreboard. **Prune one stale line for each you add.**
7. **COMMIT** — one Conventional Commit (commit only) + a short Korean report:
   what / why+URL / before→after / residual risk.

## Non-negotiable gates

- **Autonomous through COMMIT; NEVER push** — push needs Jinan's explicit
  approval (`commits.md`). This is a hard rule, not a preference.
- **Find work from data/backlog, never ask "what should I build."** The whole
  point of this skill is that you stop having to decide.
- **No "done" without VERIFY green AND WRITE-BACK complete.** "Tested" never
  means `tsc`-only.
- `fabrication=0`, `MUSE_LOCAL_ONLY`, draft-first outbound are not negotiable
  (`CLAUDE.md` + `.claude/rules/`).

## Self-gate — don't make trivial work ceremony

A one-line / typo / obvious fix SHORT-CIRCUITS: skip PLAN + analyze, go straight
BUILD → VERIFY → COMMIT. If this skill ever makes a 3-line fix take 6 steps, it
has failed — route around it and fix the skill.

## Red flags — STOP

- About to ask the human what to build → No. Read the backlog / self-eval first.
- About to push → No. Commit only; approval gates push.
- Clustering `.muse/runs` traces on a cloud model or committing raw trace text →
  Privacy violation. Cluster on LOCAL gemma4 only; store redacted labels + counts.
- Trusting the same-model judge as the sole gate on a fabrication-critical claim →
  Deterministic scorers FIRST; judge is a tie-breaker that itself passed
  `eval:judge`.
- "Found 4 failures → here's a taxonomy" on thin data → That's theater. Below
  ~20-30 real failures, hand-read and fix the obvious one; fall back to backlog.
