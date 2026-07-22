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
| Phoenix | self-hosted OpenTelemetry trace viewer, annotations, datasets and TypeScript eval SDK | complements Muse OTel; overlaps scorer execution | strongest local-first fit when self-hosted; synthetic/redacted data only in a POC | TS SDK fits; server adds Docker/Python ops | medium operational cost and UI latency | **EVALUATE P2** only if P1 local artifacts are too hard to inspect. POC: 20 synthetic traces, zero network egress, <10 min setup, one known trace defect found; remove it if any condition fails or ongoing ops exceed the value |
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
