---
title: Failure Modes & Observability
audience: [developers, AI agents]
purpose: Why harnesses collapse (mostly the harness's fault, not the model's) and the minimum machinery to trace and recover
status: draft
updated: 2026-06-13
sources_basis: [Agent observability guides 2026, Harness engineering guides 2026, Anthropic multi-agent research system, Addy Osmani long-running agents, Judge reliability harness]
related: [../core/verification-and-guardrails.md, ../core/team-roles.md, ../host/muse-mapping.md, ../README.md]
---

# Failure Modes & Observability

> **Why is this the fork toward "the best harness"?** The key one-liner from 2026 production
> data: **about 60% of agent failures come from harness defects, not the model's lack of
> reasoning** (context management, tools, recovery, data). In other words, the answer is a
> **better harness**, not a better model. This document organizes where those failures come from
> and the minimum machinery to see and fix them, grounded in verified 2026 references. (Prose
> only, no code.)

## 1. Where the harness collapses (failure modes)

- **Context rot.** In long tasks the context overflows, and the model turns timid near the limit
  or loses information → set a "working-memory budget" and **compact/reset** rather than merge
  ([handoff-template](../core/handoff-template.md)).
- **Conflicting implicit decisions.** Parallel workers who cannot see each other's full context
  work under mismatched assumptions (the single-thread counter-principle of
  [team-roles §0](../core/team-roles.md)).
- **Tool malfunction.** A wrong tool description sends the agent down the wrong path → put
  human-interface-level care into tool design.
- **Cascading failure.** In long autonomous work a minor failure spreads into a large behavior
  change → **checkpoint resume**, not restart.
- **Endless search / over-spawning.** Over-creating subagents for simple work, or endlessly
  searching for something that doesn't exist → start broad then narrow, and size the agent count
  to the work.
- **Data defects.** A large share of enterprise failures is a problem with the **data** entering
  the harness, not the model → filter input quality/provenance with guardrails
  ([verification-and-guardrails](../core/verification-and-guardrails.md)).
- **Coordination failure > capability failure (MAST).** The 14 failure modes from 1,600+ real
  traces group into three categories: ① system-design defects ② inter-agent mismatch (handoffs)
  ③ absence of verification (arXiv 2503.13657) — the prescription is explicit schema validation
  at every handoff, explicit termination conditions, and an independent verification stage; our
  form enforcement, loop limits, and evaluator gate map to each respectively.

## 2. Minimum observability (what to record)

Without observability you cannot fix non-deterministic failures (most systems are currently
uninstrumented — which is exactly why this is a differentiator). Record per-stage spans so that
**the place a failure surfaces is the place it gets fixed**.

- **Tool-call records** — tool name, arguments, **raw output**, duration, retry count, error
  state.
- **Reasoning/decision records** — why the model made that choice (plans, branches). Inputs and
  outputs alone are not enough.
- **Hierarchy records** — the tree descending orchestrator → worker → tool. Shows at which layer
  things diverged.
- **Cost & stages** — tokens/cost per stage and per run (multi-agent spends far more — track
  where it leaks).
- **State transitions** — the handoff form's stage changes (PLAN/BUILD/EVAL…) as an append-only
  log.
- **Attribution by instrumentation — no post-hoc LLM judgment.** Automated blame of who/which
  step caused a failure reaches only 53.5% accuracy at agent level and 14.2% at step level
  (Who&When 2505.00212). Leave deterministic signals — per-stage schema checks, state diffs — so
  attribution can be *read* from the logs. Per-layer no-LLM deterministic tests catch regressions
  that aggregate metrics hide (layer slices of −25 to −91pp dilute to −1.7 to −5.9pp in
  aggregate, 2606.11686) — the runner's per-layer test suite is exactly this shape.

## 3. Recovery (surviving failure)

- **Checkpoint resume.** Save state at meaningful branch points → resume from the last point on
  failure.
- **Idempotency.** Re-execution must not produce duplicate side effects (never send the same
  thing twice).
- **Backoff & circuit breaking.** Exponential backoff on tool failures, circuit breaking on
  cascading errors.
- **Human-in-the-loop points (HITL).** Production favors a **single well-scoped agent + human
  checkpoints + Plan-Execute-Verify stage gates** — **controllability**, not autonomy, is what
  builds trust.
- **Blast-radius limiting.** Risky execution in an isolated sandbox; tool access kept narrow.

## 4. Verify the judge too (judge reliability)

The evaluator (LLM judge) is also wrong sometimes — so calibrate and check the judge itself:

- **Calibration set.** Keep 200–500 human-labeled examples.
- **Recalibration signal.** If correlation with human judgment drops (e.g. r<0.7) or the
  disagreement rate exceeds 20–25%, re-tune the rubric.
- **Domain calibration.** A judge validated for chat cannot be reused as-is for code review or
  agent tasks — re-examine per domain.

## 5. One-line summary (observability/recovery checklist)

1. Do tool calls record name, arguments, output, time, retries, and errors — **all of it**?
2. Are **reasoning/decisions** and the **hierarchy (orchestrator→worker→tool)** traced?
3. Do long tasks **resume from checkpoints**, and are side effects **idempotent**?
4. Is risky execution **isolated** and tool access **narrow**?
5. Does the judge have a **calibration set**, and is it **recalibrated** when it drifts?

---

## Sources (verified basis)

- [Agent Observability: The Complete Guide for 2026 (Braintrust)](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026) (span types ↔ failure modes, tool-span fields)
- [What Is Harness Engineering? (NxCode, 2026)](https://www.nxcode.io/resources/news/what-is-harness-engineering-complete-guide-2026) (~60% of failures are the harness; working-memory budget · sandbox)
- Addy Osmani — [Long-running Agents](https://addyo.substack.com/p/long-running-agents) (single well-scoped + HITL checkpoints + Plan-Execute-Verify)
- Anthropic — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (end-to-end tracing · checkpoints · failure modes)
- [Judge Reliability Harness (arXiv 2603.05399)](https://arxiv.org/abs/2603.05399) (judge calibration/recalibration criteria)
- [MAST — Why Do Multi-Agent LLM Systems Fail? (2503.13657)](https://arxiv.org/abs/2503.13657) (1,600+ traces · 14 modes · 3 categories) · [Who&When (2505.00212)](https://arxiv.org/abs/2505.00212) (automated attribution 53.5%/14.2% — replace with instrumentation) · [Layer-Isolated Evaluation (2606.11686)](https://arxiv.org/abs/2606.11686) (per-layer no-LLM CI gates)
