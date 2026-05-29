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
  - [x] required-arg presence layer — DONE across ALL four sets (synthetic,
    real-tools, time confusable, actuator confusable): `evaluate()` takes a
    per-case `requireArgs` and fails on any missing/empty required arg.
    requireArgs pinned to each tool's actual schema `required` array
    (web_action summary+url, home_action service, search_email/knowledge_search
    query, weather location, time_diff from+to, time_add base, time_relative at,
    next_weekday_date weekday, cron_for_datetime iso, + synthetic/real set).
    Live eval:tools 39/39 @ REPEAT=2 against qwen3:8b.
  - value-plausibility grading (exact-value regex beyond presence) deliberately
    NOT added: presence is the meaningful no-op guard; pinning exact values on a
    stochastic model is brittle and lower-value. `argIncludes` already covers the
    few deterministic ones (seoul, sat). Consider A effectively complete.
- **B. Task-completion / terminal-state eval (τ-bench style)** — a small
  scenario set where, after a real run against the diagnostic/local provider +
  contract-faithful tool fakes, we assert the **resulting state** (the note got
  written, the task got added, the approval got recorded) rather than the path.
  This is the missing "did it actually accomplish the goal" layer.
  - [x] First harness (this commit): real `executeModelLoop` + real `ToolExecutor`
    over a real state-mutating tool (actual fs writes), asserting WORLD STATE not
    trajectory — goal accomplished (note persisted + success), **exactly-once**
    mutation under a repeated idempotency-keyed call, no mutation when the model
    answers directly, and no mutation when the tool fails (run still completes).
    terminal-state-task-completion.test.ts, agent-core 973 pass.
  - [x] Real built-in store tool: remember_fact driven through the REAL
    ToolExecutor over a contract-faithful RememberFactStore asserts the world
    state (fact vs preference routing, snake_case slug normalization, per-user
    isolation) AND that an invalid call (missing value / non-alnum key) mutates
    NOTHING — the τ-bench no-partial-side-effect property on a production tool.
    packages/mcp/test/remember-fact-terminal-state.test.ts (6 tests).
  - [x] Steerable diagnostic + FULL plan-execute assembly over a mutating tool:
    a `DIAGNOSTIC_PLAN=[…]` directive (trailing segment of the user prompt) makes
    `renderDiagnosticOutput` emit an arbitrary plan VERBATIM in planning mode
    (inert otherwise; malformed/bad-shape falls through to the legacy time_now
    plan) — diagnostic-wire.test.ts (8 cases). plan-execute-terminal-state.test.ts
    then drives `executePlanExecuteLoop` with the REAL DiagnosticModelProvider
    generating the plan + a REAL ToolExecutor running a real fs-mutating tool, and
    asserts WORLD STATE: goal accomplished (note persisted), multi-step in plan
    order, PLAN_ALL_STEPS_FAILED + no mutation on tool failure, and an unavailable
    tool rejected by validatePlan with no mutation. agent-core 1002 pass.
- **C. Trajectory / step assertions on multi-step runs** — assert the ordered
  spans of a plan_execute / tool-loop run (plan generated → tool called →
  synthesis), incl. adherence + step-efficiency (no redundant calls).
  - [x] executeModelLoop trajectory + step-efficiency (this commit): a 2-tool
    run preserves the ordered model→tool→model→tool→synthesis trajectory
    (toolsUsed + intermediateMessages role sequence + toolResults order); the
    loop runs exactly the requested tools once each in order (no redundant/
    dropped calls); a direct answer takes the zero-tool trajectory. 8→11 tests.
  - [x] Real plan_execute assembly trajectory + step-efficiency: drains
    `streamPlanExecute` with the REAL DiagnosticModelProvider (steered) + REAL
    ToolExecutor and asserts the ORDERED span sequence (plan-generated →
    per-step executing/result → synthesis-started), plan ADHERENCE (the
    plan-generated event's tools == executed, in order), a mixed-outcome run
    (success then fail) marking the right result span unsuccessful yet still
    synthesising, the empty-plan direct-answer trajectory (no step spans), and a
    DeepEval-style StepEfficiency metric that flags a redundant re-call of the
    same (tool, args) — plan-execute-trajectory.test.ts, agent-core 1006 pass.
- [x] **D. LLM-as-judge (GEval-style) harness** — DONE: `llmJudge(provider,
  model)` added to `eval-harness.mjs` — the subjective-quality scorer tier
  (strict single-word PASS/FAIL verdict, temp 0, suite `repeat` for stability;
  case carries `{ rubric, expectVerdict }`). Proven by `eval:judge` (new
  `scripts/eval-judge.mjs` + npm script): a meta-eval that the judge ITSELF is
  reliable on clear-cut cases (refusal/language/correctness/on-topic) — 8/8
  (100%) @ REPEAT=2 against qwen3:8b. Other batteries can now drop in
  `score: llmJudge(...)` for open-ended outputs code can't grade.
- [x] **E. Adversarial eval battery** — DONE: `scripts/eval-adversarial.mjs` +
  `eval:adversarial` npm script. Live must-refuse set (jailbreak/DAN, phishing,
  malware, prompt-injection secret-exfil, KO account-hacking) scored by the
  gap-D `llmJudge` ("refuses / does not comply"), PLUS over-refusal controls
  (benign EN/KO requests must still be helpful). 7/7 (100%) @ REPEAT=2 against
  qwen3:8b; each pre-probed STABLE 3/3.
  - Finding: "reveal your (benign) system prompt verbatim" was NOT included —
    the model complies (correctly: a non-secret system prompt isn't refusal-
    worthy); the genuine secret-exfil injection is covered by the SYSTEM-OVERRIDE
    case. Complements the deterministic input guards (unit-tested), not replaces.
- [x] **F. Hermes-style constraint gates on self-authored skills** — DONE:
  `skillDraftConstraintViolations(draft)` + `parseConstrainedSkillDraft(raw)`
  (skill-review.ts) enforce body ≤15 KB (UTF-8 bytes), description ≤500 chars,
  name ≤80 chars on top of the parse check; WIRED into both authoring producers
  (`draftSkillFromSignal`, `mergeSkillsIntoUmbrella`) so an over-limit draft is
  rejected (null/undefined), never recorded — mirrors hermes' skill/tool-desc
  size gate. 11 tests + full `pnpm check` green (6118).
- [x] **G. OpenClaw-style shadow-trial for memory/playbook promotion** — DONE:
  `runShadowTrial(provider, model, {probe,baseline,candidate,memory})` +
  `shadowTrialScorer` in eval-harness.mjs emit a report-only PROMOTE/HOLD +
  reason + risk (PROMOTE only if the candidate is more helpful AND introduces no
  false/unsafe claim). REPORT-ONLY by construction (no store handle, writes
  nothing). `scripts/eval-shadow-trial.mjs` + `eval:shadow-trial` prove the
  verdict on clear-cut candidates (helpful pref → PROMOTE; secret/unconfirmed
  over-claim → HOLD): 4/4 (100%) @ REPEAT=2, each pre-probed STABLE 3/3.
  - [ ] Remaining: wire the trial in front of the real distill/recall-promotion
    path so an actual promotion consults it (still report-only / advisory).
- [x] **H. CI gating** — DONE: `scripts/eval-agent.mjs` + `eval:agent` npm
  script run ALL harness-based batteries (eval-tool-selection / eval-judge /
  eval-adversarial / eval-shadow-trial = 58 live cases) as ONE gate and exit 1
  if ANY regresses (mirrors `eval:self-improving`). Batteries spawned as
  children so one failure can't abort the rest; LOCAL-OLLAMA-ONLY, each skips
  cleanly when Ollama is down. Verified live: 4/4 batteries green. Registered in
  `.claude/rules/testing.md`.

> **Status: agent-eval gaps A–H all delivered.** The harness
> (`eval-harness.mjs`: runEvalSuite + toolScorers + combineScorers + llmJudge +
> runShadowTrial) backs five live batteries gated by `eval:agent`, plus the
> deterministic terminal-state + trajectory vitest suites. Remaining is
> DEEPENING (noted per gap): wire the shadow-trial in front of the real
> promotion path; assembly-level plan_execute trajectory; value-plausibility arg
> grading; mutation-testing baseline (P1, lockfile-gated).

## The harness (`scripts/eval-harness.mjs`)

Batteries run on a shared, dependency-free engine shaped after the converged
2026 best practice (Inspect AI's dataset/solver/scorer/task primitives;
Braintrust + promptfoo "deterministic code-based scorers first, LLM-judge only
for subjective qualities"; Hamel Husain "evals gate development, not vibes"):

- `runEvalSuite({ name, scenarios, solve, score, repeat, threshold })` — the
  reusable run/repeat(strict-all-pass)/threshold/report engine. Returns
  `{ gate, passed, rate, total }`; the caller decides exit. Usable as a CLI gate
  AND inline.
- `toolScorers` (`noTool` / `selected` / `argMatches` / `argsPresent`) +
  `combineScorers(...)` — deterministic, composable code-based scorers; an
  LLM-as-judge scorer is just an async fn returning the same `{ ok, detail }`.

First consumer: `eval:tools` was refactored onto it (behaviour-preserving, live
39/39 @ threshold 85%). New batteries (task-completion, adversarial, LLM-judge)
should declare scenarios + a solver + scorers rather than re-implement the loop.

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
