# AI agent testing strategy (reviewed 2026-07-19)

This is Muse's adoption decision for testing the **agent as a system**: model,
prompts, tools, policy, memory, orchestration, and the environment it changes.
The TypeScript runner decision remains in
[`testing-strategy.md`](testing-strategy.md); this document covers the
non-deterministic agent layer above ordinary code tests.

## Decision

Keep Muse's provider-neutral `Dataset -> Solver -> Scorer -> Report` harness as
the canonical gate. Do not add an eval framework merely because it has a trace
UI or built-in judges. The current stack already has deterministic scorers,
terminal-state batteries, tool selection and irrelevance cases, adversarial
tests, infrastructure-failure classification, and strict `pass^k`.

Adopt the methods that the current primary sources converge on:

1. grade final world state first and inspect the trajectory second;
2. use deterministic code graders wherever the result is objectively knowable;
3. isolate every trial and repeat stochastic cases;
4. test both positive and negative behavior, including no-op and no-collateral
   outcomes;
5. inject tool, policy, memory, and orchestration failures;
6. turn locally reviewed real failures into regression cases;
7. use model judges only for qualities code cannot grade, calibrated against
   human labels and never as the sole safety gate.

No dependency is added by this decision. A new library must catch a reproduced
Muse failure that the current harness misses before it can graduate from a
bounded proof of concept.

## Required test portfolio

| Layer | What it must prove | Muse technique | Merge meaning |
| --- | --- | --- | --- |
| Deterministic code | parsers, reducers, guards, stores, protocols and provider adapters obey exact contracts | Vitest, `node:test`, fast-check where the invariant has a large input space | necessary, never sufficient for agent behavior |
| Tool use | correct tool and arguments; no irrelevant/eager tool; approval before a state-changing action | `eval:tools`, input-sensitive fakes, policy tests | selection and action boundary are sound |
| Task outcome | the requested terminal state exists and unrelated state is unchanged | isolated fixture/store/database plus deterministic end-state scorer | preferred agent success gate |
| Trace invariant | only order that is truly contractual: policy lookup before action, validated handoff, bounded termination, retry backed by verification | persisted trace assertions; exact, in-order, any-order, subset or superset match chosen per invariant | diagnostic or safety gate, never exact-path theatre |
| Reliability | the same case works repeatedly, across equivalent wording and realistic context | strict `pass^k`; KO/EN and paraphrase/metamorphic variants | one green run is not reliability |
| Fault tolerance | timeout, rate limit, partial response, schema drift, tool crash, corrupt memory, lost handoff and restart do not produce false success or collateral mutation | injected failures with deterministic recovery/end-state assertions | required for the affected boundary |
| Adversarial safety | prompt/tool-output injection, goal hijack, tool misuse, privilege abuse, memory poisoning, data exfiltration and cascading failure are contained | deterministic guard tests plus adversarial agent batteries | every safety-critical case must pass |
| Human and dogfood | graders are fair and the suite matches real use | local trace review, explicit outcome receipts, user feedback -> redacted golden case | calibrates automation; never uploads by default |

Capability suites and regression suites have different jobs. A capability suite
should contain useful hard cases and may begin below 100%; once a case is
reliably solved it graduates into an all-pass regression suite. Safety suites
are all-pass from the beginning. A skip is `unverified`, never `passed`.

## Current measured baseline

The 2026-07-19 live aggregate is documented in
[`agent-capability-baseline.md`](agent-capability-baseline.md). Its qualified
result is **10/11 axes passed, 1 failed, 0 unverified**. The aggregate itself is
not green: the executed recall axis failed. Recall scored **18/24**, while its
separate diagnostics showed ordinary-positive top-1 **14/14**, absent-fact
abstention **8/8**, and correction freshness **0/2**. These metrics have
different denominators and must not be added together.

This snapshot demonstrates the distinction above:

- correction freshness is an open live **capability gap**;
- targeted tool-selection **222/222**, safety **150/150**, browser-injection
  **9/9**, and the relevant deterministic suites are regression evidence;
- final live tool selection, SSE, and evidence-gated objective completion each
  held `pass^3`, but none of those results can offset the recall failure.
- independent adversarial review found and closed a coding-runner isolation
  escape; the strict fixture boundary then passed Rust **49/49**, deterministic
  agent contracts **121/121**, focused implementation checks **476/476**, and
  the affected live edit-run-verify axis at `pass^3`.

The earlier broad tool-selection observation was **375/377**. The later
**222/222** result is a targeted regression set, and the aggregate `pass^3` is a
third reliability observation. They are a progression, not one combined score.

## Metrics that matter

- Primary: terminal task success, policy compliance, no collateral mutation,
  tool selection accuracy, argument correctness, irrelevance accuracy, recovery
  success, and strict per-case `pass^k`.
- Diagnostic: steps, redundant tool calls, handoff failures, tokens, latency,
  cost, infrastructure retries, and refusal/over-refusal balance.
- Product: explicit user outcomes such as `used`, `adjusted`, `ignored`, and
  `rejected`; these remain distinct from synthetic eval scores and factual
  interaction receipts. A task transition can corroborate progress but never
  silently become a usefulness label or permission grant.

Do not use test count, coverage percentage, or average judge score as proof that
the agent improved. For a safety or regression gate, one critical failure cannot
be averaged away by many easy passes.

## Muse inventory and gaps

| State | Evidence in Muse | Decision |
| --- | --- | --- |
| HAVE | `scripts/eval-harness.mjs` already provides dataset/scenario, solver, deterministic or model scorer, infra classification, strict repeats and all-pass safety floors | deepen it; do not replace it |
| HAVE | the 11-axis `eval:agent` aggregate plus tool selection, adversarial, orchestration, browser/computer and multistep batteries cover major agent surfaces with versioned completion evidence | keep diff-to-battery selection and real local-model runs; preserve failed vs unverified |
| HAVE | OpenTelemetry, persisted run events, Browser Mode/Playwright, Testcontainers and local outcome receipts provide the raw seams for state and trace evaluation | reuse these Interfaces |
| DONE P0 | `muse.eval.trial/v1` and `muse.eval.summary/v1` provide opt-in local JSONL with allowlisted metadata and opaque trace refs | keep prompt/output/detail/fixture out of artifacts and fail closed on writer errors |
| DONE P0 | common per-attempt setup/teardown guarantees cleanup for opted-in batteries; secret-persistence is the first migrated fixture | teardown failure overrides pass/exclusion; migrate another battery only when it owns mutable trial state |
| DONE P0 | `eval:agent:offline` runs deterministic eval contracts after the existing build on Linux and Windows; local-Ollama `eval:agent` stays separate | a live skip remains unverified, never a CI pass |
| DONE P0 | live coding evals use a caller-only canonical `isolationRoot`; strict Seatbelt blocks fixture-external contents and unsupported hosts report `sandbox-missing` without child execution | keep absolute cwd, symlink escape, external sentinel, and real Node fixture probes in the offline gate |
| DONE P0 | live aggregate runtime assemblies use a leased disposable HOME plus explicit local-store paths and disable user-memory extraction | assert owner `~/.muse` manifests are byte-stable before/after real trials and always clean the temporary root |
| PARTIAL P1 | `eval:evidence` validates complete local artifacts, extracts terminal failures, requires explicit redaction review before case promotion, and compares per-case baseline deltas | use it in weekly dogfood; automatic redaction and dataset insertion remain forbidden |
| GAP P1 | paraphrase/metamorphic robustness and controlled tool/API fault matrices are present only in isolated tests | add shared perturbation and fault fixtures, beginning with provider routing and Continuity |
| GAP P1 | Attunement has outcome receipts but not an end-to-end natural-return agent suite | build cases from real life/work returns only after explicit human labels exist |
| DONE P1 | Explicit CLI Pack opens can produce a content-addressed Shadow return timing receipt | test exact Delivery/thread/time binding, strict prior ordering, tie/missing abstention, replay, no older backfill, authority non-inference, rollback backup, inspect/forget, and non-fatal write failure; do not count it as a natural-return usefulness label |
| DONE P1 | Configured AttuneGraph projects exact Shadow-return relations into a complete reserved-scope snapshot | test persisted-ledger capability admission, exact Delivery/thread/time join, only `PRECEDED` plus `OBSERVED_DURING`, forbidden-authority predicates, deterministic replay/content IDs, v1 receipt compatibility, queryability, stale-source refusal, non-fatal CLI graph failure, and active-head removal after source forget; do not claim physical journal erasure |
| DONE P1 | Continuity records exact local `open-to-done` interaction receipts separately from explicit outcomes | test anchor/source binding, ambiguous/relinked/pre-delivery refusal, byte-idempotent replay, and unchanged feedback/readiness counts |
| DONE P1 | Future v3 execution checkpoints can provide exact context-only Continuity evidence | test workspace/run/step binding, mixed-format precedence, legacy/v2 refusal, symlink and unstable-file refusal, bounded safe projection, cross-workspace isolation, and explicit resume-authority refusal |

### Implementation order

1. **P0 — trustworthy evidence plumbing (done 2026-07-17):** structured local
   result artifact, per-attempt isolation hooks, and deterministic offline CI.
2. **P1 — real distribution:** redacted trace-to-case promotion, baseline delta
   reports, paraphrase/fault matrices, then Attunement natural-return cases.
3. **P2 — optional tooling experiments:** only after P0/P1 reveal a concrete
   visualization or adversarial-generation defect the current stack cannot
   economically close.

### Local reviewed-evidence workflow

`eval:evidence` never reads the trace refs carried by a P0 artifact. It validates
that the artifact is complete, then handles only allowlisted IDs, statuses, and
opaque refs. Every output path is explicit, local, and exclusive. Outputs use
mode `0600` on POSIX; Windows removes inherited access and installs a protected
owner-only ACL because [Node documents that Windows `chmod` cannot express
owner/group/other modes](https://nodejs.org/api/fs.html#fschmodpath-mode-callback).
The Windows path uses PowerShell's documented
[`Set-Acl`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl)
on the empty exclusive file, verifies the protected access rules and open-file
identity, and only then writes evidence bytes.

```sh
pnpm eval:evidence -- candidates --artifact <results.jsonl> --out <candidates.jsonl>
pnpm eval:evidence -- promote --candidates <candidates.jsonl> --review <review.json> --out <case.json>
pnpm eval:evidence -- compare --baseline <baseline-results.jsonl> --current <current-results.jsonl> --out <delta.json>
```

Synthetic/debug raw artifacts for the live capability work stay under
`.muse-dev/evals/agent-capability/`. The `.muse-dev/` tree is ignored and these
local artifacts are never committed; only reviewed, privacy-safe aggregate
counts and stable reason codes may enter repository documentation.

Promotion accepts only a `muse.eval.case-review/v1` record with
`decision: "promote"`, `redactionConfirmed: true`, and the exact candidate key.
The human reviewer writes the deliberately redacted `input` and `expected`;
Muse does not infer that personal text is safe. The committed
`muse.eval.case/v1` retains an irreversible source fingerprint, not local case
IDs or trace refs. A delta gates green only when the current artifact's semantic
gate is green and no case is failed, regressed, removed, or unverified.

## Library and service assessment

Every candidate is judged on the same fields: named Muse failure class, unique
detection value, overlap, local/offline privacy and provider neutrality,
deterministic CI and Node/TS7 fit, maintenance/dependency cost, run latency/cost,
and a falsifiable adoption gate.

| Candidate | Muse failure / unique value | Overlap with current harness | Local/privacy/provider fit | CI + TS7 fit | Cost | Verdict and evidence gate |
| --- | --- | --- | --- | --- | --- | --- |
| Muse eval harness | scattered results, isolation and CI gaps; uniquely changes the exact runtime Muse ships | canonical implementation | fully local and provider-neutral | Node-native; already in CI tests | lowest incremental cost | **HAVE/DEEPEN** because it already catches Muse regressions; implement P0 |
| Inspect AI | sandboxed external-agent benchmarks and a mature task/dataset/solver/scorer ecosystem | high conceptual overlap | self-hostable/provider-flexible, but Python is a second toolchain | poor fit for the TS7 inner loop | high integration and environment cost | **REJECT as core**; reconsider only if a named external benchmark cannot be reproduced through Muse's harness |
| AgentEvals / LangSmith | exact/in-order/any-order/subset/superset trajectory matching | Muse can implement the few contractual match modes directly | library concepts are useful; hosted LangSmith trace export conflicts with local-by-default data | TypeScript exists, but message-model coupling adds an Adapter | medium dependency and optional hosted cost | **REJECT now**; adopt a match mode only when a real Muse trace invariant needs it |
| OpenAI Evals / trace grading | hosted trace-to-dataset workflow and structured graders | duplicates harness and observability concepts | provider-specific and hosted; cannot own `agent-core` or receive user traces by default | API integration is possible but not deterministic/offline | network, storage and judge cost | **REJECT as canonical**; use concepts only |
| Google ADK evaluation | separate final-response, tool-use, trajectory, safety and simulated-user criteria | overlaps current scorers and multi-turn batteries | framework/provider-specific hosted judge paths | Python-first criteria and cloud requirements do not fit the core gate | cloud and judge sampling cost | **REJECT as canonical**; use outcome/trajectory separation as a design reference |
| Braintrust | immutable experiments, per-case deltas, production trace -> dataset workflow | fills P1 UX but duplicates scoring/runtime | hosted-by-default is incompatible with personal trace privacy; no external telemetry by default | TypeScript SDK exists; CI requires service state | dependency, account, storage and judge cost | **REJECT by default**; no POC until the owner explicitly opts into redacted external telemetry |
| Phoenix | self-hosted OpenTelemetry trace viewer, annotations, datasets and TypeScript eval SDK | complements Muse OTel; overlaps scorer execution | strongest owner-controlled fit when self-hosted; synthetic/redacted data only in a POC | TS SDK fits; server adds Docker/Python ops | medium operational cost and UI latency | **EVALUATE P2** only if P1 local artifacts are too hard to inspect. POC: 20 synthetic traces, zero network egress, <10 min setup, one known trace defect found; remove it if any condition fails or ongoing ops exceed the value |
| Promptfoo | generated agent/MCP attacks and OpenTelemetry trace-based red-team analysis | overlaps `eval:adversarial`, but can broaden attack generation | local CLI is possible; external attack/judge providers and real traces are forbidden by default | Node-friendly; generated cases are not deterministic CI evidence until frozen | medium runtime and false-positive triage cost | **EVALUATE P2** only after a documented OWASP threat lacks a Muse case. POC: synthetic target, fixed seed/config, one novel reproducible breach promoted to a deterministic Muse test; remove it if it finds none or requires user data/cloud judges |

An `EVALUATE` result is not a soft adoption. The experiment is time-bounded,
uses synthetic or deliberately redacted data, and is removed when its exit
criteria fail. `ADOPT` requires a before/after regression that the existing
stack misses and the candidate catches reproducibly.

## Execution ladder

1. **Edit loop:** one deterministic test or `pnpm test:changed --uncommitted`.
2. **Push/PR:** affected typecheck/lint/tests and deterministic agent gates
   selected by `scripts/pick-evals.mjs`; no live skip can be described as pass.
   The long live aggregate is **not a pre-push gate**.
3. **Prompt/tool/model/routing change:** local real-model battery with strict
   `pass^k`, isolated trials, and before/after per-case results.
4. **Nightly or self-hosted gate:** live agent aggregate, provider contracts,
   fault matrix, and longer multi-turn scenarios without blocking the fast edit
   loop on unavailable local infrastructure. The aggregate may also be run
   manually for a release candidate or a prompt/tool/model/routing change.
5. **Weekly dogfood review:** sample local traces and explicit outcomes, redact
   the smallest reproducible failure, and add it to a capability or regression
   suite. External upload requires a separate explicit opt-in.
6. **Release:** Linux/Windows code checks, browser/E2E and PostgreSQL jobs where
   relevant, plus the live agent and safety gates for changed surfaces.

## Sources retrieved for this review

Official documentation and project guidance were retrieved on **2026-07-17**;
dates below are publication dates where the source provides one.

- Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (2026-01-09): outcome/transcript graders, isolated trials, balanced tasks, transcript review, capability vs regression suites, `pass@k` vs `pass^k`.
- OpenAI, [Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals) (retrieved 2026-07-17): trace grading for workflow diagnosis, then datasets/eval runs for repeatability.
- Google ADK, [Evaluation criteria](https://adk.dev/evaluate/criteria/) (2026 documentation): separate final response, tool use, task success, trajectory, groundedness and safety criteria.
- LangSmith AgentEvals, [Trajectory evaluations](https://docs.langchain.com/langsmith/trajectory-evals) (retrieved 2026-07-17): strict, unordered, subset and superset match modes.
- UK AI Security Institute, [Inspect](https://inspect.aisi.org.uk/) (retrieved 2026-07-17): task = dataset + solver + scorer, agent sandboxes, external-agent support and transcript scanning.
- Arize, [Phoenix](https://arize.com/docs/phoenix) and [client-side evals](https://arize.com/docs/phoenix/evaluation/concepts-evals/evaluators) (retrieved 2026-07-17): self-hostable OpenTelemetry traces, TypeScript evaluators, datasets, experiments and human labels.
- Promptfoo, [red-team agents](https://www.promptfoo.dev/docs/red-team/agents/) (retrieved 2026-07-17): component, end-to-end and OpenTelemetry trace-based adversarial testing.
- Braintrust, [agent evaluation](https://www.braintrust.dev/articles/agent-evaluation) (2026-02-26) and [systematic evaluation](https://www.braintrust.dev/docs/evaluate) (retrieved 2026-07-17): datasets, tasks, scores, immutable experiments, CI and production feedback loops.
- OWASP, [Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) (2025-12-09): goal hijack, tool misuse, privilege, supply chain, code execution, memory/context poisoning and multi-agent risks.
- Yao et al., [`tau`-bench](https://arxiv.org/abs/2406.12045) (2024-06-17): database end-state grading and `pass^k` reliability.
- Cemri et al., [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) (2025-03-17): specification, inter-agent alignment, verification and termination failure taxonomy.
- Gupta, [ReliabilityBench](https://arxiv.org/abs/2601.06112) (2026-01-03, emerging single-author preprint): paraphrase robustness and controlled timeout/rate-limit/partial-response/schema-drift fault surfaces. This is a research lead, not a normative foundation.

## Method and sources, in full

Moved here from `.claude/rules/verification/agent-testing.md` on 2026-07-30. The rule file
is auto-loaded into every session and this material is reference — it restated the rule's
own sections "in full", so every request paid for both tellings.

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
