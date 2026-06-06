# Multi-agent orchestration — the evidence-based direction for a LOCAL 8B agent

Jinan's directive (2026-06-07): make Muse's multi-agent orchestration + sub-agent
use **more efficient, more accurate, better** — the way Claude Code / Codex do —
grounded in papers + references, verified, iterated. This file is the
research-grounded plan. It is the authority on WHAT to build and, just as
important, **what NOT to build**, for an agent running entirely on a local
qwen3:8b (`MUSE_LOCAL_ONLY` default-on).

## The one decisive fact (read this first)

**For a small (~7–8B) model, homogeneous multi-agent DEBATE actively HURTS.**
"The Cost of Consensus" (arXiv 2605.00914) measured qwen/ministral-class models:
debate **drops** accuracy and burns **2.1–3.4× more tokens** — Qwen2.5-7B
MMLU-Hard 66.7% → 60.7%, Ministral-8B GSM-Hard 48.3% → 20.7%. Three named
failure modes: **sycophantic conformity** (agents abandon a correct answer to
match peers, up to 85%), **oracle gap** (the team HAD the right answer but voting
threw it away), **contextual fragility** (peer context destabilises reasoning).
"Should we be going MAD?" (arXiv 2311.17371) independently finds default debate
does NOT beat plain self-consistency at far higher cost.

⇒ **Muse must NOT build qwen-vs-qwen debate / chatty peer agents.** What helps a
small local model is **decomposition + verification + cascade**, all realisable
as ONE model in fresh isolated contexts with typed hand-offs — never peers
arguing. This *reinforces* Muse's grounding-gate edge instead of competing with it.

## Principles (convergent across Anthropic, OpenAI, Cognition, + the papers)

1. **Context is the scarce resource, not capability.** Every source frames the
   core problem as what fits the window and what contaminates it. Sub-agents win
   by ISOLATING noise (a side-task that returns 3 findings after reading 50
   files), not by adding voices.
2. **Start simple; add an agent only when it demonstrably improves the outcome.**
   The single point of full convergence (Anthropic "Building Effective Agents",
   OpenAI SDK, Cognition). Default to one model + tools; escalate to orchestration
   only when the task can't be done in one pass.
3. **One writer, many readers.** Parallel READS are safe; parallel WRITES to
   shared state are the Flappy-Bird failure (Cognition). A reviewer with CLEAN
   context (no knowledge of the writer's reasoning) catches more, not less.
4. **Isolation + a typed hand-off artifact beats a shared scratchpad.** Each
   sub-task gets a self-contained brief and returns ONE summary string; nesting
   depth = 1 (both Anthropic Claude Code and OpenAI Codex hard-cap it).
5. **Verification against the ORIGINAL objective is the highest-ROI single
   intervention.** MAST (arXiv 2503.13657) measured a verification step focused
   on the high-level task → **+15.6% absolute** success; clearer role specs →
   +9.4%. Most multi-agent failures are organisational (design/coordination,
   ~78%), not model-capability.
6. **Cheap-first cascade.** FrugalGPT: query the cheapest path first, escalate
   only on a low confidence/quality score → up to 98% cost cut at equal accuracy.
   Local-only-compliant: "escalate" = a bigger LOCAL model or an honest "I'm not
   sure" — never cloud under `MUSE_LOCAL_ONLY`.
7. **The four-element sub-agent brief.** Anthropic's research system failed on
   vague prompts (duplicated work). Every delegation needs: **objective + output
   format + tool scope + task boundary**. Doubly true for qwen3:8b
   (`tool-calling.md`).

## What Muse already has (keep + deepen)

- `packages/multi-agent`: `MultiAgentOrchestrator`, `SupervisorAgent.selectWorker`
  (handoff routing), `OrchestrationMode` = sequential | parallel | race,
  `synthesizeFinalAnswer` (final fusion), tiering (`classifyTier`,
  `planTieredRun`), an in-memory message bus + orchestration history.
- `packages/a2a` (cross-Muse swarm, inbound inert), `packages/agent-specs`,
  the `harness/` planner→worker→evaluator roles, `muse orchestrate` /
  `muse agents` (manual sub-agents in `~/.muse/agents`).
- The grounding gate / RGV — which IS a verification step; the papers (MAST,
  Weaver) are academic backing to keep hardening it.

## The gaps (prioritised build/verify list — one slice per fire)

Each item names its falsifiable check; nothing counts until the check is green
on local qwen3:8b (per `agent-testing.md`: grade the terminal state, `pass^k`,
maker ≠ judge).

1. **Verification-against-original-objective gate in the orchestrator.** Today
   `synthesizeFinalAnswer` fuses worker outputs but nothing re-checks the fused
   answer SATISFIES the user's original ask. Add a final verify step (reuse the
   RGV/`llmJudge` seam, a SEPARATE narrow invocation — maker ≠ judge). *Check:* a
   multi-step orchestration whose synthesis drops a required part is caught and
   re-run / flagged (mirror MAST's +15.6%); terminal-state test + a live battery.
2. **Decomposition with the four-element typed hand-off.** Turn worker ROUTING
   into task DECOMPOSITION: the orchestrator emits sub-tasks each carrying
   {objective, output format, tool scope, boundary}, run in ISOLATED context,
   returning one summary string. Apply MAST anti-failure rules (explicit
   termination, no duplication). *Check:* a task single-shot qwen fails but
   decomposed-qwen passes, with a planted bad sub-result caught by step 1.
3. **Confidence-gated self-consistency on WEAK verdicts (cheapest win).** When
   the grounding verifier is uncertain, sample K=3–5 constrained answers and
   majority-vote ONLY the citation-grounded ones; no agreement → "I'm not sure."
   Parallel, single-model, no coordination risk (self-consistency, arXiv
   2203.11171: +6–18% on reasoning). *Check:* live battery — accuracy up on
   ambiguous cases, fabrication-rate unchanged (0).
4. **Local-first cascade with an explicit escalate/abstain score.** Local qwen
   first; on a low verifier score, escalate to a bigger LOCAL model OR abstain —
   never cloud. *Check:* low-confidence path abstains/escalates, high-confidence
   exits early; assert token savings.
5. **A small, dedicated verifier — not generator self-grading.** Weaver shows a
   small/distilled verifier is high-leverage, and "LLMs can't reliably
   self-correct" (arXiv 2310.01798) means the generator must not be its own
   judge. Keep verification a separate cheap call. *Check:* `eval:judge`-style
   meta-eval that the verifier itself is reliable.

## Rejected (do not re-propose)

- **qwen3:8b-vs-qwen3:8b debate / multi-round argue-to-consensus.** Degrades
  accuracy + triples tokens on small models (arXiv 2605.00914, 2311.17371);
  sycophantic conformity + oracle gap. Decomposition + verification + cascade
  deliver the same goal without the harm.
- **Recursive sub-agent nesting > 1 level.** Anthropic + OpenAI both hard-cap it;
  deeper = super-linear latency/token/debug cost.
- **Parallel WRITES to a shared store** (calendar/notes/memory). Parallel read,
  serial write — the Flappy-Bird failure otherwise.
- **Over-delegation.** Spawning a sub-agent for what the main turn can answer is
  "pure waste" (Claude Code docs). Delegate only to isolate context the main
  window won't need again.

## Sources (verified)

- MAST — Why Do Multi-Agent LLM Systems Fail? [arXiv 2503.13657](https://arxiv.org/abs/2503.13657)
- The Cost of Consensus (isolated self-correction > homogeneous debate, 7–8B) [arXiv 2605.00914](https://arxiv.org/html/2605.00914v1)
- Should we be going MAD? (debate ≯ self-consistency) [arXiv 2311.17371](https://arxiv.org/abs/2311.17371)
- Self-Consistency [arXiv 2203.11171](https://arxiv.org/abs/2203.11171) · Multi-Agent Debate [arXiv 2305.14325](https://arxiv.org/abs/2305.14325)
- LLMs cannot self-correct reasoning yet [arXiv 2310.01798](https://arxiv.org/pdf/2310.01798) · Weaver weak-verifier ensembling [Stanford](https://scalingintelligence.stanford.edu/pubs/weaver.pdf)
- FrugalGPT cascade [TMLR 2024](https://lingjiaochen.com/papers/2024_FrugalGPT_TMLR.pdf) · Planner vs Orchestrator [arXiv 2504.02051](https://arxiv.org/pdf/2504.02051)
- Anthropic — Multi-agent research system [engineering](https://www.anthropic.com/engineering/multi-agent-research-system) · Building Effective Agents [research](https://www.anthropic.com/research/building-effective-agents)
- Cognition — Don't Build Multi-Agents [blog](https://cognition.ai/blog/dont-build-multi-agents) · what's working [blog](https://cognition.ai/blog/multi-agents-working)
- Claude Code sub-agents [docs](https://code.claude.com/docs/en/sub-agents) · OpenAI Agents SDK orchestration [docs](https://openai.github.io/openai-agents-python/multi_agent/) · Codex sub-agents [docs](https://developers.openai.com/codex/subagents)
