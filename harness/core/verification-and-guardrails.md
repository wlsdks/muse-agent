---
title: Verification Gates & Guardrails
audience: [developers, AI agents]
purpose: Make the harness's evaluator and gates actually trustworthy — grading rubric, input/output guardrails, gate operating rules
status: draft
updated: 2026-07-19
sources_basis: [LLM-as-a-Judge practical guide, OpenAI Agents SDK guardrails, Anthropic building-effective-agents, Cognition don't-build-multi-agents]
related: [team-roles.md, handoff-template.md, ../host/muse-mapping.md, ../README.md]
---

# Verification Gates & Guardrails

> **Why is this the core of "the best harness"?** The harness's bottleneck is not making but
> **confirming it is right** ([team-roles §0](team-roles.md)). This document collects the rules
> that make the evaluator and gates of [team-roles](team-roles.md) actually trustworthy — how to
> grade consistently, the guardrails that block what comes in and goes out, and when and how to
> apply gates — grounded in verified 2026 references. (Prose only, no code.)
>
> **Primary source (Boris Cherny, creator of Claude Code, 2026):** verification is **the most
> important thing** for quality — an external verification feedback loop makes final quality
> **2–3×**. Our independent evaluator, completion gate, and deterministic hooks are exactly that
> feedback loop. **Updated 2026-07-30:** what this does NOT mean is adding model
> *self*-verification steps ("double-check your answer", "re-verify before responding", "use a
> subagent to verify your own output") — current frontier models verify their own work unprompted,
> and Anthropic's Opus 5 prompting guide names such instructions as legacy harness scaffolding
> that now makes results worse ([AGENTS.md §7](../AGENTS.md)). The feedback loop this harness
> keeps is *external*: deterministic gates plus a different-instance evaluator.

## 1. Make the evaluator judge well (grading rubric)

If the evaluator is generous or inconsistent, the gate is meaningless. Verified LLM-as-judge
practice rules:

- **A clear, concrete rubric.** Define not "is it good?" but "what must be true to pass", as
  itemized criteria (the handoff form's acceptance criteria play that role).
- **A simple scale.** **Pass/fail**, or a low-granularity scale like 1–3, is more consistent than
  a fine-grained scale like 1–10.
- **Calibrate with examples.** A few pass/fail examples (few-shot) align verdicts to the criteria.
- **Block biases.** Consciously block position bias (preferring the answer that came first),
  verbosity bias (preferring longer answers), and **self-preference bias** (preferring one's own
  answer) — which is why **the maker and the judge must be separated**.
- **Look at the path, not just the outcome.** Agent evaluation looks at three axes together:
  ① task completion (goal reached?) ② path quality (were the steps efficient and logical?)
  ③ appropriateness of tool selection.

> **Primary-source validation (Anthropic Outcomes, 2026-05 Code with Claude):** a separate grading
> agent that **cannot see the task agent's reasoning chain and grades only the output** against a
> rubric improved quality by +8.4% (Word) / +10.1% (PPT) **with no model change**. Our
> "maker ≠ judge + rubric grading" is exactly that structure — Anthropic proved the quantitative
> gain with the same design (our `.claude/agents/harness-evaluator` enforces the separation via
> tool permissions too, by having no write permission).

## 2. Block what comes in and goes out (guardrails)

If evaluation is "grade when finished", guardrails are "block immediately, mid-flight". Two kinds:

- **Input guardrails** — inspect user input before processing (off-topic, malicious requests,
  etc.). On a hit, stop before the main work even starts.
- **Output guardrails** — inspect results before they leave (policy violations, sensitive-data
  exposure, etc.).
- **Tripwires (immediate halt).** On detecting a violation, raise the signal at once and **stop
  execution immediately** — saving cost and latency.
- **Filter cheaply, in parallel, first.** Run fast, cheap checks **alongside** the main work (the
  expensive model), and end early on a hit.

> Muse context: input/output defenses and deterministic safety gates already exist in the product
> (SYSTEM-MAP #12). The harness's guardrails apply that same philosophy **to agent-team
> boundaries** as well.

## 3. When to apply gates (operation)

- **Plan approval gate (front)** — look at the plan once before implementation. Fixing a bad plan
  is far cheaper than fixing bad code.
- **Completion gate (back)** — on task completion, check against acceptance criteria + (where
  possible) run automated tests. Only a pass moves to the next stage/merge.
- **Blocked-first (fail-closed).** If verification fails or is uncertain, do not pass. No PASS
  without evidence.
- **Loop caps.** Explicit termination conditions (iteration count, time ceiling) that prevent
  infinite repetition. If it doesn't end, escalate to a human.
- **Retries and reflection require an external verifier.** A "think again" retry with no
  verification signal repeats the same violation ~85% of the time (arXiv 2510.18254), and
  intrinsic self-correction actually lowers accuracy (2310.01798) — only tool-grounded critique
  works (CRITIC: fixes made while holding code-execution or search results). So a BUILD↔EVAL
  iteration must always return carrying the evaluator's concrete feedback (which criterion was
  violated, and how); a bare retry without feedback is treated as loop waste and cut. (Muse-side
  enforcement: the reflection-schedule guard in `../../.claude/rules/verification/agent-testing.md` — every retry
  surface registers its verifier.)
- **PLAN FAIL is not blocker-count accounting.** Never `BLOCKED` on the raw `PLAN FAIL` count
  alone. PLAN review distinguishes **material progress** — closing a previous blocker or making
  acceptance/accounting measurable — from **no-progress** — the same blocker repeating with no new
  evidence or fix. Escalate only on no-progress or at the declared time/cost cap, and count the
  BUILD↔EVAL repair budget separately.
- **Evaluation feedback is one-pass bundling.** The evaluator returns every blocker reasonably
  discoverable in one pass, bundled, as concrete violations. For any later new blocker, record why
  it could not have been found in the earlier pass. There must be grounds — such as a prior fix
  opening a new path; unexplained sequential disclosure is no-progress of the evaluation loop.
- **Do not mix evidence axes.** Synthetic scale and `realismProxy` are not evidence quality.
  Verify the immutable `dataOrigin` (synthetic / consented trace-derived) and `executionEvidence`
  (not-run / live-executed) independently. Controlled replay is only public-interface dry-run
  evidence, never organic production authority, and interpreting a factual interaction receipt as
  feedback/outcome/policy promotion is a gate FAIL.

## 4. Strong against failure (observability & recovery)

- **Trace the whole flow.** Record not just inputs/outputs but **reasoning, tool calls, and
  intermediate decisions**, step by step. Traces are the only way to debug non-deterministic
  behavior. Hierarchical records (orchestrator → worker → tool) work well.
- **Track steps and cost.** Observe tokens/cost per step and per run (multi-agent uses
  significantly more tokens).
- **Resume from a checkpoint.** Long autonomous work saves state at meaningful branch points and,
  on failure, **resumes from the last checkpoint**, not from scratch.
- **Idempotency.** Repeated execution must not produce duplicate side effects (never send the same
  message twice, etc.).
- **Circuit breaking & backoff.** Contain tool failures and cascading errors with retries
  (backoff) and circuit breakers so they don't spread.

## 5. One-line summary (gate checklist)

1. Are the acceptance criteria **concrete** (judgeable as pass/fail)?
2. Is the judge **different from the maker**, with biases blocked?
3. Are there **guardrails** on input and output, with an **immediate halt** on violation?
4. Are there **gates** at the plan front and completion back, and does uncertainty **block**?
5. Are **traces and cost** recorded, and does failure **resume from a checkpoint**?

---

## Sources (verified basis)

- [LLM-as-a-Judge: A Practical Guide](https://towardsdatascience.com/llm-as-a-judge-a-practical-guide/) (clear rubric · low-granularity scale · few-shot calibration · bias blocking)
- [OpenAI Agents SDK — Guardrails](https://openai.github.io/openai-agents-python/guardrails/) (input/output guardrails · tripwires · parallel early exit)
- Anthropic — [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) (simplicity · transparency · gates)
- Anthropic — [Outcomes: agents that verify their own work](https://platform.claude.com/cookbook/managed-agents-cma-verify-with-outcome-grader) (2026-05; a separate output-only grading agent → model-unchanged +8.4%/+10.1%)
- Cognition — [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) (full-context sharing · conflicting implicit decisions · single-thread first)
- Limits of self-correction — [Illusions of Reflection (2510.18254)](https://arxiv.org/abs/2510.18254) (reflective retries repeat the same violation ~85%) · [LLMs Cannot Self-Correct Reasoning Yet (2310.01798)](https://arxiv.org/abs/2310.01798) · [CRITIC (2305.11738)](https://arxiv.org/abs/2305.11738) (only tool-grounded critique works)
- Boris Cherny (creator of Claude Code) — [Latent Space interview](https://www.latent.space/p/claude-code) (verification is the most important thing for quality; the verification feedback loop 2–3×es final quality; harness = a thin wrapper over the model)
