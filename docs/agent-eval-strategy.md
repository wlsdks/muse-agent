# Agent-eval strategy (research-grounded, 2026-05)

Researched the current best practice for testing AI agents and how the two
reference agents (Nous **hermes-agent** + **OpenClaw**) do it, then mapped it
onto Muse. This is the north star the test-hardening loop now optimises toward —
it sits ABOVE the mechanical `testing-backlog.md` and tells the loop *which kind
of agent test is worth the most*.

## What the field says (2026)

1. **Step / trajectory-level eval, not just final output.** ~90% of agent
   failures happen mid-execution; score each span — plan, tool call, retrieval,
   synthesis — independently. (Confident AI, Adaline, CodeAnt.)
2. **Metric taxonomy (DeepEval).** Reasoning: *PlanQuality*, *PlanAdherence*.
   Action: *ToolCorrectness*, **ArgumentCorrectness**. Overall: *TaskCompletion*,
   *StepEfficiency*. Custom: *GEval* = LLM-as-judge over a plain-English rubric.
3. **Final-state-based task eval (τ-bench / τ²-bench / AppWorld).** Multiple
   distinct tool paths can satisfy one goal, so assert the **terminal state**
   (resulting file/db/record) + the final response — NOT exact trajectory
   matching. Trajectory match is for *selection*; state is for *completion*.
4. **Golden datasets**: known input + expected tool calls + target output;
   synthetic generation to widen coverage + real examples for edge cases.
5. **LLM-as-judge** for open-ended outputs, with a rubric; noisier than human
   labels, so pin temperature 0 + repeat for stability.
6. **CI-gated regression.** DeepEval is pytest-native precisely so evals gate
   every PR. "An eval suite that runs ad-hoc but never gates a PR catches
   regressions late." Three pillars: offline golden evals + runtime input/output
   guardrails + production tracing with drift alerts.
7. **Adversarial / safety dimension**: prompt-injection, jailbreak, eager-
   invocation, unsafe tool use — as first-class eval batteries, not afterthoughts.
8. **User-simulator / scenario testing**: a meta-agent drives multi-turn
   conversations to surface failure modes (arXiv 2508.17393).

## How the reference agents do it

- **hermes-agent self-evolution** (ICLR'26 Oral, MIT): every evolved variant
  passes **constraint gates** before a human sees it — full `pytest tests/` 100%
  green, **size limits** (skill ≤15 KB, tool description ≤500 chars), cache-
  compatibility, semantic-preservation. GEPA reads **execution traces** to
  diagnose *why* a run failed, not just that it did. Nothing direct-commits;
  all changes are human-reviewed.
- **OpenClaw dreaming QA Lab**: a **shadow-trial** reviews a candidate memory
  *before* promotion — compare a baseline answer vs an answer allowed to use the
  candidate, emit a **verdict + reason + risk flags**, and keep the report
  **separate from live `MEMORY.md`** (report-only; no unintended promotion). The
  deep-phase promotion engine is gated, explainable, reviewable.

## Muse: what we already have (good — keep + deepen)

- `eval:tools` / `eval:tools:nl` — tool-SELECTION golden set incl. confusable
  sets + adversarial negatives (eager-invocation resistance). Matches #2 (tool
  correctness) + #7 partly. Exact-tool match = selection, not completion.
- `eval:self-improving` — 4 LLM batteries (pattern-suggestion, preference-
  inference, skill/playbook merge).
- `smoke:live` — real Qwen e2e round-trip across the request/response surface.
- `self-eval` scoreboard — the regression-gate concept (#6).
- Guards (input prompt-injection / PII) are deterministic + unit-tested (#7).

## Muse: the gaps this loop should close (priority order)

- **A. ArgumentCorrectness battery** — extend the tool evals to assert the
  *arguments* are right (not just the tool name): a graded check per case
  (required args present, values plausible). Cheapest high-value gap on top of
  the existing `eval:tools` harness.
  - [x] required-arg presence layer (this commit): `evaluate()` now takes a
    per-case `requireArgs` and fails the case if any required arg is missing/
    empty; annotated the synthetic + real-tool cases (city/query/expression/
    text+when, math_eval/slugify/text_stats/hash_text/time_diff). Live
    eval:tools 39/39 @ REPEAT=2.
  - [ ] Remaining: value-plausibility grading (beyond presence) for the
    actuator/time confusable sets (web_action url, home_action service+entity,
    time_add base+days, cron iso) once their arg shapes are pinned.
- **B. Task-completion / terminal-state eval (τ-bench style)** — a small
  scenario set where, after a real run against the diagnostic/local provider +
  contract-faithful tool fakes, we assert the **resulting state** (the note got
  written, the task got added, the approval got recorded) rather than the path.
  This is the missing "did it actually accomplish the goal" layer.
- **C. Trajectory / step assertions on multi-step runs** — assert the ordered
  spans of a plan_execute / tool-loop run (plan generated → tool called →
  synthesis), incl. adherence + step-efficiency (no redundant calls).
- **D. LLM-as-judge (GEval-style) harness** — a reusable judge (local Qwen,
  temp 0, repeat-for-stability) scoring open-ended outputs against a plain-
  English rubric, for things exact-match can't grade (summaries, drafts).
- **E. Adversarial eval battery** — promote prompt-injection / jailbreak /
  unsafe-tool-use from unit guards into a scored live battery (must-refuse set),
  mirroring the eager-invocation negatives already in `eval:tools`.
- **F. Hermes-style constraint gates on self-authored skills** — Muse authors
  skills at session end; gate each authored skill on size (≤15 KB), tool-desc
  length, and a parse/lint check before it's loadable (mirror hermes).
- **G. OpenClaw-style shadow-trial for memory/playbook promotion** — before a
  distilled strategy / promoted memory goes live, a report-only baseline-vs-
  candidate judge with verdict/reason/risk, kept separate from the live store.
- **H. CI gating** — make the eval batteries a real gate (extend `self-eval`)
  so a tool-selection / task-completion regression fails the run, not just logs.

## Loop rule

Each fire, advance the highest-priority open item from **A→H above** (or the
matching `testing-backlog.md` entry), one coherent slice per commit. Live
batteries run against local Qwen (Ollama); pre-verify new eval cases STABLE 3/3
before landing; keep the deterministic gates (package suite + `pnpm lint`).
Depth over breadth.

## Sources

- [Confident AI — LLM Agent Evaluation guide](https://www.confident-ai.com/blog/llm-agent-evaluation-complete-guide)
- [DeepEval — AI Agent Evaluation](https://deepeval.com/guides/guides-ai-agent-evaluation) · [LLM-as-a-Judge](https://deepeval.com/guides/guides-llm-as-a-judge)
- [Adaline — Complete Guide to LLM & AI Agent Evaluation 2026](https://www.adaline.ai/blog/complete-guide-llm-ai-agent-evaluation-2026)
- [CodeAnt — Evaluating LLM Agents in Multi-Step Workflows](https://www.codeant.ai/blogs/evaluate-llm-agentic-workflows)
- [Agent-Testing Agent (arXiv 2508.17393)](https://arxiv.org/pdf/2508.17393) · [Proxy State-Based Eval for multi-turn tool-calling (arXiv 2602.16246)](https://arxiv.org/pdf/2602.16246)
- [NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) · [hermes-agent](https://github.com/nousresearch/hermes-agent)
- [OpenClaw — Dreaming](https://docs.openclaw.ai/concepts/dreaming) · [Memory](https://docs.openclaw.ai/concepts/memory)
