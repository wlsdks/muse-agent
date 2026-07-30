---
title: Development Loop — how Muse gets stronger every day
audience: [AI agents, developers]
purpose: Remove the inefficiency of deciding "what to build next" ad hoc every time, and fix it as one loop grounded in the published agent-development methodology. The body that the two skills `improve-muse` and `grow-muse` activate.
format: harness layer (vendor-neutral)
updated: 2026-06-08
---

# Development Loop

> **HOST-SPECIFIC** — this is Muse's own development loop, and it names real paths in this
> repository (`internal/goals/backlog.md`, `.claude/rules/*`). Everything else under
> `.claude/harness/` is vendor- and project-neutral; this file is not.

> **This file is the contract for "what to build and how".** Where [`contract.md`](contract.md) is
> *roles, handoff, gates* (how one slice is executed), this file is *how that slice is chosen,
> verified, and its learning accumulated*. The two skills `.claude/skills/improve-muse` (HARDEN)
> and `grow-muse` (GROW) each run stages 0–7 end-to-end (pick → BUILD → VERIFY → COMMIT+PUSH) —
> "nothing to do" is a forbidden output. So that no "what should I build" prompt is ever written
> again.

## 0. The inefficiency this loop fixes (why it was made)

Symptom (Jinan, 2026-06-08): *"The feeling that I'm developing inefficiently. Every time I have to
find out by prompt what to develop."* Root cause = **the MEASURE half is strong, but the
ANALYZE+COMPOUND half is missing** → every session re-pays the orientation cost from scratch
(treadmill). Two faces:

1. **Direction doesn't accumulate.** No single entrypoint, and the persistent backlog had been
   deleted, so "what's next" was re-discovered per slice by an expensive scout subagent and thrown
   away. → Fix: write [`../../internal/goals/backlog.md`](../../internal/goals/backlog.md) once and the next fire reads it
   first.
2. **Data doesn't pick the slice.** Traces pile up in `.muse/runs/` but nobody reads them, and
   work is picked by "feels high-value". → Fix (incremental): outcome-logging instrumentation →
   failure clustering picks the slice. (No labels yet, so the backlog takes priority for now; see
   [`../../internal/goals/backlog.md`](../../internal/goals/backlog.md).)

## 1. Principles (the consensus across public methodology — follow them)

All cross-verified against primary sources (§4). On conflict, [`../../CLAUDE.md`](../../CLAUDE.md) +
`.claude/rules/*.md` win.

1. **Data picks the slice, not feelings.** Read your own traces → classify failures → rank by
   frequency so Pareto picks the work. The highest-ROI activity in AI development (Husain;
   NurtureBoss removed 60%+ of failures by fixing 3 modes). Until enough labels accumulate,
   substitute the top backlog item.
2. **On a fixed small model, the *harness* is the lever — not model size.** Agent = an LLM looping
   over tools; capability = tools × planner (Weng · Willison · Huyen · Ng; Ng's "GPT-3.5 loop >
   GPT-4 zero-shot"). The weaker the model, the more performance swings on harness quality
   (METR ~23.8pt). But get the first action right — an 8B's coherence collapses at 3+ steps of
   reasoning ([`../../.claude/rules/safety/tool-calling.md`](../../.claude/rules/safety/tool-calling.md)).
3. **Improve by subtraction.** Ablate tools and remove the ones contributing nothing (Huyen); the
   CLAUDE.md 100-line cap; subtractive correction-decay. Contracts, skills, and backlog become
   noise an 8B ignores if they only ever grow — add a line, prune a line.
4. **The inner loop is single-threaded by default. Subagents only for *parallel, read-heavy,
   independent* exploration.** Keep tightly coupled build/fix decisions in one agent (Cognition
   "Don't Build Multi-Agents"; Anthropic's multi-agent is +90% but ~15× tokens, only for
   parallelizable work). Broad investigation like gap-finding is the right use of subagents. Mind
   context engineering (write/select/compress/isolate) and context rot.
5. **Verify, then claim — fail-closed, maker≠judge, pass^k.** Grade terminal states/outcomes;
   binary verdicts (temp 0); no green battery, not done; the evaluator is a different instance
   from the worker + same-model verdicts calibrated via the eval:judge meta-eval. "Tested" is
   never tsc-only.
6. **Accumulate learning as write-back — the step everyone skips, and the one that turns the
   treadmill into a flywheel.** Failures become permanent golden cases, repeated corrections
   become one rule line, chosen/discarded directions + source URLs go to the backlog. Voyager's
   skill library and Generative Agents' memory+reflection are the academic roots of this
   accumulation. No automatic self-improvement anyone trusts exists ([[obra/superpowers is a
   manual ritual]]), so write-back is a *completion gate*.
7. **Own the load-bearing pieces as code — not framework magic or prompt requests** (12-Factor).
   Policy, gates, and the surface→battery map live in version control (not in someone's head).

## 2. Canon map — technique → source → Muse status

Dev-loop techniques and eval techniques. HAVE = present / PARTIAL = partial / MISSING = absent /
N-A = irrelevant.

| Technique | dev/eval | Source | Muse |
|---|---|---|---|
| ReAct (interleaved reasoning↔acting) | dev | arXiv 2210.03629 | HAVE (plan-execute/model-loop) |
| Reflexion (feedback→verbal self-reinforcement) | dev | 2303.11366 | HAVE (correction-decay) |
| Self-Refine (generate→critique→revise) | dev | 2303.17651 | HAVE (ask --repair + judge) |
| Voyager (growing callable skill library) | dev | 2305.16291 | HAVE (playbook/skills) |
| Generative Agents (memory stream+reflection) | dev | 2304.03442 | HAVE (episodic+reflection) |
| Self-RAG / CRAG (trust-gated retrieval) | dev | 2310.11511 / 2401.15884 | HAVE (grounding gate) |
| Error-analysis flywheel (look at your data) | dev | Husain · Yan · Google AgentOps | **PARTIAL — no fuel (trace labeling needed)** |
| pass^k reliability | eval | τ-bench 2406.12045 | HAVE (MUSE_EVAL_REPEAT) |
| Binary LLM-judge + meta-eval | eval | Husain · Google rubric_v1 | HAVE (eval:judge) |
| Trajectory vs final separation + match modes | eval | Google ADK criteria | **MISSING (backlog)** |
| Sentence-level groundedness (hallucinations_v1) | eval | Google ADK | **MISSING (backlog)** |
| Cost-controlled evaluation (simple baselines first) | eval | "AI Agents That Matter" 2407.01502 | PARTIAL |

> The key reading: **the dev-loop techniques are almost all HAVE.** What's empty is *eval
> refinement* and *the fuel of the error-analysis flywheel*. So the next work is not "add another
> technique" but "fill the holes in measurement and accumulation".

## 3. THE LOOP — one fire per day

Each fire = one verified slice. Cheapest stage first, fail-closed.
The entrypoints are **two skills** (split 2026-07-17): `improve-muse` (HARDEN — reliability, debt,
and deletion of what exists) and `grow-muse` (GROW — new user-facing capability). Each runs stages
0–7 autonomously end-to-end (pick → BUILD → VERIFY → COMMIT + **PUSH**) and never outputs "nothing
to do". One loop moves one axis, so to move both axes, pair the loops or alternate the calls. This
document is the detail of the shared execution contract (0–7); each skill's `SKILL.md` owns the
sourcing ladder and permission boundaries.

0. **PRE-FLIGHT** — confirm Ollama is up (`curl -s localhost:11434/api/tags`); reconcile with
   concurrent auto-push loops via `git fetch`; rebuild touched dependency packages (removing the
   tax of stale dist masquerading as a bug).
1. **ORIENT (regression first)** — `pnpm self-eval`. If a previously passing gate dropped, fixing
   *that* is this fire's entire work — stop here and fix it.
2. **FIND WORK (autonomous)** — the sourcing ladder is owned by the invoking skill:
   `improve-muse` goes regression → failure signals → live pain probe → hardening backlog →
   subtraction; `grow-muse` goes owner direction → dogfood friction → north-star gap → parity
   reservoir (D/T/N/C scored). Gap-finding and the capability-parity reservoir belong to
   grow-muse. **Never ask the human "what should I build" — probes and data pick.**
3. **PLAN** — WHAT+WHY+the gate to strengthen, as a one-line contract in
   [`handoff.md`](handoff.md). If trivial (a typo, one line), skip and
   short-circuit to 5 (skill self-gate).
4. **BUILD** — one vertical slice, minimal scope, deterministic code (not prompts). Own the
   prompt/schema/control flow; strengthen one gate or add one verb_noun tool. No new framework
   abstractions.
5. **VERIFY (fail-closed)** — `node scripts/pick-evals.mjs` maps the diff → the exact eval/smoke
   subset and prints it (code, not memory; grounding/safety gets MUSE_EVAL_REPEAT=3
   automatically) + the invariants (fabrication=0 *on real traces too*, lint 0/0,
   **`pnpm test:changed`** (vitest related — only the tests related to changed files, not a whole
   package suite), and `pnpm check` pre-commit / when cross-package). Grounding/safety is pass^k
   k≥3. Independent evaluator = the independent-evaluator subagent (no write tools), calibrated via
   the eval:judge meta-eval. Not green, not done.
6. **WRITE-BACK (completion gate — no done declaration without it)** — (a) the fixed failure
   becomes a STABLE-3/3 golden case; (b) Jinan's repeated correction becomes one line in
   `.claude/rules/*.md` (after-correction); (c) chosen + discarded directions + sources go to
   [`../../internal/goals/backlog.md`](../../internal/goals/backlog.md), durable facts to MEMORY.md; (d) before→after to
   the self-eval scoreboard. When a set grows, prune one stale line.
7. **COMMIT + PUSH** — one Conventional Commit + `git push` (current branch). The `improve-muse` /
   `grow-muse` skills hold standing push authorization (2026-06-27, Jinan) — but push **only when
   VERIFY is green**; red means no push. On non-FF, `git pull --rebase` then retry (no force).
   Plus a short report in Korean (what/why + URL / before→after / residual risk). The next fire's
   ORIENT reads a thicker rule set, golden suite, and backlog, so it is *strictly cheaper*.

## 4. Anti-patterns (how this loop ruins itself — block them)

- **Ceremony on trivial work.** Orient→analyze→spec→handoff on a one-line fix is pure overhead.
  → The skill self-gates: if trivial, short-circuit to build+verify+commit. Otherwise it gets
  bypassed and the skill dies.
- **Error-analysis theater on thin data.** Turning 4 failures into a "taxonomy" is fake rigor.
  Below ~20–30, read by hand, fix the one obvious thing, and fall back to the backlog. Do not copy
  the NurtureBoss numbers as if they were law.
- **Privacy leakage (the most Muse-specific risk).** Sending raw trace text to a cloud model, or
  committing it verbatim into a taxonomy, violates the identity ("you can tell it everything" +
  MUSE_LOCAL_ONLY). → Clustering on LOCAL gemma4 only; the taxonomy holds redacted labels + counts
  only. Enforced in code (not prompts).
- **maker=judge collapse.** With a single local model, the evaluator/judge can rubber-stamp the
  worker (TNR<25%). → Deterministic scorers first; trust the judge only as a tie-breaker and only
  after it passes the eval:judge meta-eval. Never make a same-model judge the sole gate on a
  fabrication-critical claim.
- **Golden-suite overfitting.** If write-back only adds back-catalog, the suite ossifies and stops
  catching new drift. → Re-sample fresh traces every fire; grow the suite as a *distribution*.
- **Contract/skill bloat.** Accumulation past what an 8B can carry backfires. → Add a line, prune
  a line; if SKILL.md grows into an everything-doc, progressive disclosure collapses.
- **Infinite harness polishing.** Scaffold gains compound early and saturate soon (METR: +8pp
  non-significant on an already-elicited agent). Once the loop is tight, stop the
  meta-engineering and return to capability.

## 5. Honest limits (2026-06-08 will-it-work adversarial review)

What this loop *cannot* do — the ceiling a 6-path review confirmed in code. Ignore it and it breaks.

- **Network/data clause.** `MUSE_LOCAL_ONLY` blocks **LLM/voice egress only** — downloading public
  eval datasets is allowed. But vendor them into `apps/cli/scripts/fixtures/` + pin checksums +
  commit, so reproduction is offline. (Without this clause the agent gets blocked *by its own*
  skill-erected gate and stalls.)
- **On a single model, maker=judge — `eval:judge` is advisory.** The same gemma grading the same
  gemma on toy fixtures carries almost no signal about this slice's truth. Fabrication-critical
  claims take **deterministic scorers first**, otherwise an **opus independent-evaluator (a separate,
  stronger model session, write tools removed)**. This is the irreducible "needs a stronger
  model/human" point — a fixed 12B cannot self-certify the grounding claim it just made.
- **WRITE-BACK is now mechanical.** `scripts/guard-writeback.mjs` (a commit-msg hook) forces a
  non-trivial `feat`/`fix` to stage one of test/golden-case/backlog updates (escape
  `[writeback: n/a]`). Code, not a prose gate. Still, the *content* (is it a good golden case?)
  remains human/review judgment.
- **Autonomy lasts only as long as the seed.** Write-back records the sources of *consumed* items
  but creates no new actionable work ("add a line, prune a line" caps growth). The durable refill
  is error-analysis, which is blocked on trace outcome logging, and that fuel accumulates *from
  Jinan using Muse*, not from dev fires. → When `[open]` records run dry, a refill fire
  (gap-scout or human direction) is itself the work. Do not overrate the autonomy as "infinite
  self-improvement" — this is a tool that makes *verified slice execution cheap + cumulative*,
  not unsupervised self-evolution.

## 6. Sources (primary, verified)

- Anthropic: [Building effective agents](https://www.anthropic.com/research/building-effective-agents) · [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- OpenAI: [A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) · Google: [ADK eval criteria](https://google.github.io/adk-docs/evaluate/) · [Agents Companion whitepaper](https://www.kaggle.com/whitepaper-agent-companion)
- 12-Factor Agents (Dex Horthy/HumanLayer): https://github.com/humanlayer/12-factor-agents
- Eval-driven: Hamel Husain [Your AI product needs evals](https://hamel.dev/blog/posts/evals/) · [LLM-as-judge](https://hamel.dev/blog/posts/llm-judge/) · Eugene Yan [LLM-evaluators](https://eugeneyan.com/writing/llm-evaluators/) · Shreya Shankar (who-validates-the-validators)
- Practitioners: Lilian Weng [LLM Powered Autonomous Agents](https://lilianweng.github.io/posts/2023-06-23-agent/) · Chip Huyen [Agents](https://huyenchip.com/2025/01/07/agents.html) · Simon Willison (agent definition) · Andrew Ng (4 agentic patterns) · Jason Liu (RAG flywheel)
- Multi-agent/context: Cognition [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) · LangChain (context engineering) · Chroma [Context Rot](https://research.trychroma.com/context-rot)
- Harness: SWE-agent/ACI (2405.15793) · METR task-harness · paper canon: ReAct 2210.03629 · Reflexion 2303.11366 · Self-Refine 2303.17651 · Voyager 2305.16291 · Generative Agents 2304.03442 · τ-bench 2406.12045 · "AI Agents That Matter" 2407.01502
