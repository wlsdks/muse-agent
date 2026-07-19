# Agent-level testing — evaluating the AGENT, not just the code

Unit tests prove a function is correct; they do **not** prove the *agent*
is good — that the model picks the right tool in one shot, abstains when
it should, and reaches the real goal state *reliably*. That is
**evaluation (evals)** — ship it with every agent-facing capability. Full
method and sources: [Appendix](#appendix-sources--rationale). The dated
Muse inventory, gaps, library decisions, and implementation order live in
[`docs/development/ai-agent-testing-strategy.md`](../../docs/development/ai-agent-testing-strategy.md).

**Three principles, if you read nothing else:** (1) **Error-analysis
FIRST, imagination never** — evals GROW from real misses. (2)
**Deterministic code is the GATE; the LLM-judge is a DEBUGGER** — code
decides pass/fail on the safety-load path, the judge never gates a
safety claim alone. (3) **Grade OUTCOMES, `pass^k`, all-pass** — score
terminal state not the path; reliability is every repeat passing.

## The non-negotiables (every agent capability)

1. **Agent-level check, not just a unit test.** A tool the model never
   SELECTS is not delivered — prove it live (`smoke:live`), not `tsc`.
2. **Grade the terminal state, not the exact path.** Assert the resulting
   world state + final answer; pin trajectory order only where a step
   genuinely depends on a prior one.
3. **No partial side-effects.** A failed/invalid action mutates
   **nothing**, and a write never damages *unrelated* state — the
   deny/invalid-arg/tool-failure test path asserts an unchanged store.
4. **Reliability is `pass^k`, not one green run.** Run a grounding- or
   safety-critical case k times, require **all k** to pass
   (`MUSE_EVAL_REPEAT`); pre-verify a new live case STABLE 3/3. Never
   report `pass@k` ("at least once") as reliability.
5. **Security/safety is CODE, never a passing prompt.** A must-refuse battery
   proves the model refuses; the deterministic gate (injection patterns,
   approval gate) is the real protection — doubly so where refusal is
   language-asymmetric (an observed KO/EN gap) — and gets the regression test.
6. **Tool-calling and multi-agent hand-offs get their own asserts** —
   run `pnpm eval:tools` after touching any tool schema/description
   (selection is the binding constraint on an 8B model); validate every
   multi-agent hand-off against a typed schema and assert bounded,
   verification-backed termination. Full breakdown: Appendix.

## The layered method (cheapest grader first)

| Layer | Proves | Grader |
|---|---|---|
| Unit | a function is correct | `vitest` (deterministic) |
| Tool-calling | model SELECTS + fills the right tool in one shot | `eval:tools` (deterministic) + `smoke:live` |
| Task-completion | terminal world state reached, no collateral damage | terminal-state/trajectory tests (deterministic) |
| Multi-agent seams | hand-offs validate, loop terminates, failures surface | schema parse + bounded-step asserts |
| Production | holds on REAL traces, not fixtures | human trace-reading → new golden cases |

(1) **deterministic scorers** — selected? args present? terminal state
matches? (`toolScorers` in `eval-harness.mjs`, every case). (2)
**LLM-as-judge only for what code can't grade** — binary PASS/FAIL at
T=0 (`llmJudge`); a 1–5 rubric is an anti-pattern. (3) **Human
trace-reading, regularly** — catches a broken eval before a scorer does.

**maker ≠ judge.** One local model means the judge IS the maker, so a
safety claim is never gated by the judge alone. Compensating controls:
deterministic graders own the safety verdict; `eval:judge` meta-evaluates
the judge first; verdicts are binary and must NAME a concrete violation
("seems off" is not grounds to reject); periodic fault-injection drills
prove the judge still rejects bad work. Evidence: Appendix.

**Reliability discipline:** `MUSE_EVAL_REPEAT` (k=3 for local/self-hosted
reliability gates, k≥5 grounding/safety-critical), strict all-pass; T=0 is a
cheap gate, not a statistical guarantee. `eval:agent`/`eval:self-improving`
aggregate live local-Ollama batteries; they are not GitHub CI gates and a skip
is unverified. `self-eval` fails closed on regression. Error-analysis is FIRST — read
20–50 real traces before writing a scorer (Muse's "production" is n=1 dogfooding).

## Evaluation accounting vocabulary

Large synthetic corpora must keep semantic coverage separate from prompt volume.
A **semantic family** is one canonical objective/setup/expected/forbidden contract;
a **surface variant** changes factors or expression without becoming an independent
truth. Report both, and never relabel 20,000 surface variants as 20,000 independent
semantic cases.

Dataset accounting and agent-execution accounting are different ledgers:

- `generated = valid + invalid`; `sampled <= valid`. Generated/validated/sampled
  artifacts prove corpus integrity, **not** agent PASS.
- A **case** is one eval specification. A **trial** is one execution of a case. An
  **inference request** is one model request inside a trial; retries increase requests
  and may increase trials according to the runner contract, but never create cases.
- `pass^k` runs the same case for `k` trials and requires all `k` to pass. It increases
  trial and inference-request counts, not case, semantic-family, or surface-variant
  counts. Do not report it as `pass@k`.
- Until trials actually run, agent results remain `UNVERIFIED`/`NOT_RUN`; generated or
  validated data cannot be booked as agent passed/failed signal.

Every report names the ledger explicitly: semantic families, surface variants,
generated/valid/invalid/sampled cases, executed cases, trials, inference requests,
and agent passed/failed/unverified. Reconciliation identities are fail-closed.

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
| All harness batteries as one local/self-hosted aggregate | `pnpm eval:agent` |
| Real-LLM request/response round-trip | `pnpm smoke:live` |
| Regression scoreboard | `pnpm self-eval` |

**Anti-patterns (reject on sight):** skip-as-pass; vacuous stub (confirm
with MUTATION-RED); floor instead of ratchet (fail close on a DROP, not
just clearing a floor); counting code artifacts as agent signal;
`pass@k` reported as reliability; trajectory pinning over terminal-state
grading; same-family judge over-trust. Full rationale: Appendix below.

---
## Appendix: sources & rationale

### The layered stack and method, in full

Evals stack by CONCERN; each layer has the grader that fits it, and a
lower layer green does not imply a higher one.

**Deterministic code is the GATE; the LLM-judge is a DEBUGGER.** Every
safety-load verdict is decided by code (tool selected? arg present?
terminal state? injection pattern? approval recorded?). The judge is
reached for ONLY where code cannot grade (refusal, on-topic, citation
quality) and never stands alone on a safety claim.

Converged 2026 practice (Inspect AI, Braintrust, promptfoo, DeepEval,
Hamel Husain): **deterministic code-based scorers first; an LLM judge
ONLY for qualities code cannot grade.**

### maker ≠ judge, in full — Muse's honest constraint

The field says use a *stronger, different* model as judge so maker/judge
errors don't correlate. Muse runs ONE local model, so the judge IS the
maker — a same-family judge over-trusts its own output. Because we
cannot escape that with a stronger model, FOUR compensating controls
carry the load, and a safety claim is never gated by the judge alone:

1. **Deterministic graders carry the safety load.** The judge never
   decides a safety/security verdict; code does.
2. **Meta-eval the judge before trusting it** — `eval:judge` proves the
   judge is reliable on clear-cut cases (incl. the grounding pair: an
   honest "I'm not sure" vs a confident invention) before any battery
   consumes its verdicts.
3. **Binary verdict that NAMES a concrete violation.** PASS/FAIL at T=0;
   a FAIL must cite which criterion / invariant / state failed and how —
   a vague "seems off" is not grounds to reject (false-FAIL control).
4. **Fault-injection drills.** Periodically feed the judge work that MUST
   fail and assert it still rejects — the guard against same-family
   rubber-stamping, since a static checklist is bypassed by an adaptive
   change.

### Tool-calling (the binding constraint on an 8B model), in full

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

### Multi-agent & sub-agent / orchestration, in full

When work crosses an agent boundary — the council & reflection
surfaces, the harness worker→evaluator roles, any Workflow
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

### Reliability & non-determinism — in full

- **Repeat, don't trust one run.** `MUSE_EVAL_REPEAT` (k=3 for local or
  self-hosted reliability gates, k≥5 for grounding/safety-critical) with
  strict all-pass = `pass^k`.
- **Temperature 0 is not determinism.** Even greedy decoding varies
  across GPU/batch; T=0 + repeat is a cheap gate, not a statistical
  guarantee. A flaky single case is a signal to repeat, not to delete.
- **Automate it or it rots.** An eval that runs ad-hoc but never gates catches
  regressions late. `eval:agent` / `eval:self-improving` bundle the local live
  batteries and fail if ANY executed battery regresses; a skip remains
  unverified. `eval:agent:offline` owns the deterministic Linux/Windows CI
  contracts without rebuilding the workspace. `self-eval` is
  the regression scoreboard (a tracked count dropping is a fail-close).
- **Promote evidence, never raw traces.** `eval:evidence candidates` consumes
  only a complete privacy-safe P0 JSONL artifact. `promote` requires an exact
  candidate-bound human review with explicit redaction confirmation; `compare`
  reports case-level improvement/regression/unverified state. Never auto-read a
  trace ref, auto-redact personal text, or let a new/current failure gate green.
- **Error-analysis FIRST — the ordering principle, not an afterthought.**
  Before writing a scorer, read 20–50 REAL traces and open-/axial-code the
  failures into categories; the categories that actually recur become the
  eval cases. 20–30 golden cases from ACTUAL usage beat a large synthetic
  set; feed every real miss back in as a case. New cases come from probing
  the real path, not imagination. Muse's "production" is **n=1
  dogfooding** — the owner's own transcript review IS the trace-reading
  layer, so treat every dogfood miss as a production incident to codify.

### Anti-patterns, in full (named — reject on sight)

- **Skip-as-pass.** A battery that SKIPS (Ollama unreachable, fixture
  missing) is not a pass — exit 0 on skip is fine, but the skip must not
  count toward "verified". Fixing the environment so it runs is the work.
- **Vacuous stub.** A test that passes against a fake that ignores its
  inputs proves nothing; every fake depends on its inputs, and a new test
  is confirmed by a MUTATION-RED (break the code, watch it redden).
- **Floor threshold instead of a ratchet.** A fixed pass-rate floor lets
  quality decay down to it. Track the count/score and fail-close when it
  DROPS vs the last run (`self-eval`), don't just check it clears a floor.
- **Counting code artifacts as agent signal.** Test-file count, LOC, tool
  count measure activity, not agent quality. They are infra hygiene, never
  proof the agent got better.
- **`pass@k` reported as reliability.** "Succeeded at least once" is the
  optimistic upper bound; the user feels `pass^k` (all k pass).
- **Trajectory pinning.** Asserting one exact tool sequence is brittle —
  grade terminal state; pin order only where a step depends on a prior one.
- **Same-family judge over-trust.** Letting the maker-as-judge's verdict
  stand un-meta-eval'd, or gating a safety claim on it — see the four
  compensating controls above.

### Reflection-schedule guard, in full (policy, pinned by `scripts/reflection-guard.test.mjs`)

Self-reflection helps ONLY with an external verifier: a bare "think again"
pass repeats the original failure **85.36%** of the time on open-ended tasks
(arXiv 2510.18254). Every retry/reflection surface (repair rewrite, best-of
resample, reverify escalation, merge self-consistency, false-done re-run)
MUST be backed by a deterministic or judge-backed verifier; the guard test's
registry enumerates them, and a NEW retry surface ships with a registry
entry + its verifier, never as an unverified loop.

**The verifier itself is two-sided and must be calibrated (2026 evidence).**
A judge fails in BOTH directions, so a one-sided guard is incomplete:

- **Over-confidence / rubber-stamp** — passes bad work. A judge over-rates its
  own family: self-preference makes it mark a *failing* rubric satisfied up to
  **50%** more often and skews scores ~10 points (arXiv 2604.06996), and the
  bias remains even after controlling for raw ability (2508.06709). With a
  fixed top-tier ceiling you can't escape same-family judging, so the
  compensating control is the judge-failure **drill** (a fault-injection that
  proves the judge still rejects), not a stronger model.
- **Under-confidence / false-FAIL** — flags *correct* work as wrong **44.4%**
  of the time absent calibration, dropping to 7.7% with a calibration bonus
  (arXiv 2606.14211, "Closing the Reflection Gap"). So a FAIL verdict must name
  a *concrete* violation (which criterion / invariant / state, and how); a vague
  "seems off" is not grounds to reject and re-run.
- **Static batteries are nearly useless against an adaptive adversary** — fixed
  must-pass checklists are bypassed >90% by adaptive attacks and 100% by human
  red-teaming (arXiv 2510.09023). A safety/security verifier must reason about
  THIS change's failure mode each time, not replay a frozen question set.

These map to the loop-creator contract's gating verifier (`loop-engineering.md`
§3-1, §1.5-3, §4.5-5) — the same calibration applies to any autonomous retry.

### Sources (verified primary)

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
