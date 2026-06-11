# Agent-level testing — evaluating the AGENT, not just the code

Unit tests prove a function is correct. They do **not** prove the
*agent* is good: that the local model picks the right tool in one
shot, fills its arguments correctly, abstains when it should, reaches
the real goal state, and does so *reliably* across a stochastic model.
That is a different discipline — **evaluation (evals)** — and it is a
first-class gate here, not an afterthought.

This file is the contract for HOW we test Muse as an agent — the durable
*method* that converged across the 2024–2026 public literature and how it maps
onto Muse. When you ship an agent-facing capability, you ship its eval.

## The non-negotiables (every agent capability)

1. **An agent capability ships with an agent-level check, not just a
   unit test.** A tool whose handler is unit-tested but that the model
   never SELECTS is not delivered (`tool-calling.md`). The proof is a
   live round-trip on the local model (gemma4:12b default), not `tsc`.
2. **Grade the OUTCOME / terminal state, not the exact path.** A
   capable agent reaches a goal by several valid tool routes; asserting
   one exact trajectory is brittle and wrong. Assert the resulting
   world state — the note got written, the task got added, the approval
   got recorded — plus the final answer. (τ-bench/AppWorld/SWE-bench all
   score final state; Anthropic & OpenAI both say "grade outcomes, not
   paths.") Trajectory order is asserted only where a step genuinely
   *depends* on a prior one.
3. **No partial side-effects.** A failed or invalid agent action
   mutates **nothing** (τ-bench property), and a write never damages
   *unrelated* state (AppWorld "collateral damage"). Test the deny /
   invalid-arg / tool-failure path asserts an unchanged store — doubly
   so for Muse's calendar / reminder / memory / contacts writes.
4. **Reliability is `pass^k`, not one green run.** A stochastic agent
   proved by a single pass is not proved. Run a grounding- or
   safety-critical case k times and require **all k** to pass — this is
   `pass^k` (τ-bench), and `runEvalSuite`'s `MUSE_EVAL_REPEAT` already
   implements it (a single failing run fails the case). Pre-verify a new
   live eval case **STABLE 3/3** before landing it. Do NOT report
   `pass@k` ("succeeded at least once") as reliability — that is the
   optimistic upper bound, the opposite of what a user feels.
5. **Security/safety is tested as CODE, never as a passing model
   prompt.** A must-refuse battery proves the model refuses, but the
   real guard is the deterministic gate (injection patterns, approval
   gate). Where the model's own refusal is language-asymmetric (a KO
   credential-exfil ask the EN form refuses but the KO form does not —
   an observed, recorded finding) the deterministic guard is the
   protection, and IT is what gets the regression test.

## The layered method (cheapest grader first)

Converged 2026 practice (Inspect AI, Braintrust, promptfoo, DeepEval,
Hamel Husain): **deterministic code-based scorers first; an LLM judge
ONLY for qualities code cannot grade.**

1. **Deterministic scorers** — tool selected? required args present?
   arg value echoes the prompt literal? terminal state matches?
   `toolScorers` (`selected`/`argsPresent`/`argMatches`/`noTool`) in
   `eval-harness.mjs`. Fast, exact, no model — run these on every case.
2. **LLM-as-judge** — only for open-ended quality (refusal, on-topic,
   coherence, citation quality). **Binary PASS/FAIL, temperature 0**,
   not a 1–5 scale (Hamel Husain; Anthropic's multi-agent team
   independently found a single binary call most human-aligned). Muse's
   `llmJudge` is exactly this. A 1–5 rubric averaged into a number is an
   anti-pattern — delete it on sight.
3. **Human trace-reading** — read real transcripts regularly. Every
   practitioner (Anthropic, Hamel Husain, Eugene Yan) calls this the
   skill that stops you trusting a broken eval. The probe-the-real-path
   habit in the ops loop *is* this layer.

**maker ≠ judge — and Muse's honest constraint.** The field says use a
*stronger, different* model as judge so maker/judge errors don't
correlate. Muse runs ONE local model, so the judge IS the maker. The
compensating control is `eval:judge`: a **meta-eval that proves the
judge itself is reliable** on clear-cut cases (incl. the grounding pair
— it must tell an honest "I'm not sure" from a confident invention)
before any battery trusts its verdicts. Never let an unchecked
same-model judge be the only gate on a safety-critical claim.

## Tool-calling (the binding constraint on an 8B model)

Three layers, in priority order (BFCL methodology):

- **Selection** — right tool chosen. The headline `eval:tools` golden
  set. On a small model this is the binding constraint; argument errors
  are secondary.
- **Argument correctness** — required args present + prompt-derived
  literals echoed (`requireArgs` + `argMatches`). Grade values that are
  COPIED from the prompt (a date, a city); do NOT pin model-INVENTED
  values (a computed duration) — that is brittle on a stochastic model.
- **Irrelevance / over-invocation (IrrelAcc)** — negative cases where
  the right answer is **zero tool calls** (a greeting, a musing, small
  talk, a past-tense report). A tool set that over-fires on noise is as
  broken as one that under-fires; most suites skip this — we do not
  (the eager-invocation traps in `eval:tools`).

Run `pnpm eval:tools` (and `MUSE_EVAL_REPEAT=3`) after touching any tool
name / description / schema, the projection layer, or the Ollama adapter.

## Multi-agent & sub-agent / orchestration

When work crosses an agent boundary — the council & reflection
surfaces, the harness planner→worker→evaluator roles, any Workflow
fan-out — single-agent evals miss the failure that actually bites.
Multi-agent systems fail mostly through **coordination**, not raw
capability (MAST, arXiv 2503.13657 — 14 failure modes; the top three
are *step repetition*, *reasoning–action mismatch*, and *unaware of
termination*). So assert at the seam:

- **Validate every hand-off against a typed schema** at the boundary
  (Zod / JSON-Schema parse). One check kills most cascade failures — an
  unvalidated partial result flowing downstream is the dominant
  multi-agent bug class.
- **Termination is explicit.** Never rely on the model deciding it is
  done — assert the loop halts within a bounded step count, and that a
  "done" signal is backed by a real verification step, not a shallow
  self-report (Muse's honesty backstop is this in the chat path).
- **No duplicated / overlapping sub-agent work.** When a lead delegates,
  assert sub-tasks are scoped non-overlapping (Anthropic found vague
  sub-agent instructions made workers run identical searches). For a
  Workflow, that means distinct prompts/labels per branch.
- **Failure propagation surfaces, never silently swallows.** Inject a
  deliberate failure into a sub-step and assert the orchestrator detects
  and handles it (MAST "information withholding"). Maps to Muse's
  fail-close rule — a step that can't verify must say so, not pass a
  partial result up.
- **Reasoning–action alignment.** When the agent states a plan, assert
  the action it then takes matches the plan it just stated.

## Reliability & non-determinism

- **Repeat, don't trust one run.** `MUSE_EVAL_REPEAT` (k=3 for CI gates,
  k≥5 for grounding/safety-critical) with strict all-pass = `pass^k`.
- **Temperature 0 is not determinism.** Even greedy decoding varies
  across GPU/batch; T=0 + repeat is a cheap gate, not a statistical
  guarantee. A flaky single case is a signal to repeat, not to delete.
- **CI-gate it or it rots.** An eval that runs ad-hoc but never gates
  catches regressions late. `eval:agent` / `eval:self-improving` bundle
  the live batteries and fail if ANY regresses; `self-eval` is the
  regression scoreboard (a tracked count dropping is a fail-close).
- **Start small, grow from real failures.** 20–30 golden cases from
  ACTUAL usage beat a large synthetic set; feed every real miss back in
  as a case. New cases come from probing the real path, not imagination.

## Where each gate lives (Muse mapping)

| Concern | Muse gate |
|---|---|
| Tool selection + args + irrelevance | `pnpm eval:tools` (`eval:tools:nl`) |
| Terminal-state / trajectory (deterministic) | `*-terminal-state.test.ts`, `*-trajectory.test.ts` (agent-core) |
| Plan quality (valid∧complete∧ordered∧efficient) | `pnpm eval:plan-quality` |
| LLM-judge + its meta-eval | `pnpm eval:judge` |
| Must-refuse + over-refusal controls | `pnpm eval:adversarial` |
| Memory/playbook promotion (report-only) | `pnpm eval:shadow-trial` |
| Self-improving LLM paths (one gate) | `pnpm eval:self-improving` |
| All harness batteries as one CI gate | `pnpm eval:agent` |
| Real-LLM request/response round-trip | `pnpm smoke:live` |
| Regression scoreboard | `pnpm self-eval` |

## Sources (verified primary)

- τ-bench / pass^k — [arXiv 2406.12045](https://arxiv.org/abs/2406.12045)
- Berkeley Function-Calling Leaderboard (AST vs executable, IrrelAcc) — [gorilla.cs.berkeley.edu](https://gorilla.cs.berkeley.edu/blogs/8_berkeley_function_calling_leaderboard.html) · [ICML 2025](https://proceedings.mlr.press/v267/patil25a.html)
- MAST — why multi-agent systems fail (14 modes) — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657)
- Anthropic — [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) · [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Building effective agents](https://www.anthropic.com/news/building-effective-agents)
- OpenAI — [Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals) · [Practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- Google ADK eval criteria (trajectory match modes, rubric, user-simulator) — [adk.dev/evaluate/criteria](https://adk.dev/evaluate/criteria/)
- LangSmith / agentevals (trajectory match: strict/unordered/subset/superset) — [docs](https://docs.langchain.com/langsmith/trajectory-evals) · [github](https://github.com/langchain-ai/agentevals)
- Hamel Husain — [Your AI product needs evals](https://hamel.dev/blog/posts/evals/) · [LLM-as-a-judge](https://hamel.dev/blog/posts/llm-judge/)
- Eugene Yan — [LLM-evaluators](https://eugeneyan.com/writing/llm-evaluators/)
- G-Eval — [arXiv 2303.16634](https://arxiv.org/abs/2303.16634) · LLM-as-a-judge survey (biases) — [arXiv 2411.15594](https://arxiv.org/abs/2411.15594) · Agent-as-a-Judge — [arXiv 2410.10934](https://arxiv.org/abs/2410.10934)
- Outcome-state benchmarks — AppWorld [2407.18901](https://arxiv.org/abs/2407.18901) · SWE-bench [2310.06770](https://arxiv.org/abs/2310.06770) · GAIA [2311.12983](https://arxiv.org/abs/2311.12983)
- Inspect AI (UK AISI; dataset/solver/scorer) — [inspect.aisi.org.uk](https://inspect.aisi.org.uk/) · promptfoo agent red-team — [promptfoo.dev](https://www.promptfoo.dev/docs/red-team/agents/)
- Local-model tool-calling eval (qwen3:8b ≈ 0.93 F1) — [Docker](https://www.docker.com/blog/local-llm-tool-calling-a-practical-evaluation/)

## Reflection-schedule guard (policy, pinned by `scripts/reflection-guard.test.mjs`)

Self-reflection helps ONLY with an external verifier: a bare "think again"
pass repeats the original failure **85.36%** of the time on open-ended tasks
(arXiv 2510.18254). Every retry/reflection surface (repair rewrite, best-of
resample, reverify escalation, merge self-consistency, false-done re-run)
MUST be backed by a deterministic or judge-backed verifier; the guard test's
registry enumerates them, and a NEW retry surface ships with a registry
entry + its verifier, never as an unverified loop.
