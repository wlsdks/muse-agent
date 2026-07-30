---
title: Harness Architecture & Self-Assessment
audience: [planners, developers, AI agents]
purpose: How the harness is put together at a glance (diagram) + what exists and what is missing against the authoritative 2026 checklist
status: draft
updated: 2026-06-13
sources_basis: [awesome-harness-engineering (component checklist), Agent Harness Engineering — AI Control Plane (Masood 2026), Atlan harness tools 2026, Braintrust observability 2026, Anthropic harness-design-long-running-apps 2026-03 (pruning), Anthropic managed-agents 2026-04 (staleness)]
related: [../README.md, ../core/team-roles.md, ../core/handoff-template.md, ../core/role-prompts.md, ../core/verification-and-guardrails.md, failure-modes-and-observability.md, harness-acceptance.md, ../host/muse-mapping.md]
---

# Harness Architecture & Self-Assessment

> **What is this document?** It shows **on one page how** the harness built so far is put
> together (the diagram), and honestly assesses **what is filled and what is missing** against
> the authoritative 2026 checklist (awesome-harness-engineering's 12 categories, etc.). Prose
> only (no code). Sources at the end.

## 1. The one-page diagram (the path one task flows through)

```
                 ┌──────────────────────────────────────────────┐
                 │           Orchestrator (conductor)           │
                 │  owns full context & plan / delegates /      │
                 │  synthesizes results                         │
                 └───────────────┬──────────────────────────────┘
   delegation (goal·output·tools·boundaries)│   ▲ compressed summary returned
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
            ┌─────────┐     ┌─────────┐     ┌──────────┐
            │ Planner │ ──▶ │ Worker  │ ──▶ │Evaluator │   (maker ≠ judge)
            │ plan    │     │ build   │ ◀── │  PASS/   │
            └─────────┘     └─────────┘ feedback  FAIL │
                 │                │           └────┬─────┘
                 └────────────────┴────────────────┘
                        all fill the same one page
                 ┌──────────────────────────────────────────────┐
                 │  Handoff artifact (1 per task, owns state)   │
                 │  plan → build → eval → review + open         │
                 │  questions + status log                      │
                 └──────────────────────────────────────────────┘
   Cross-cutting foundations (apply to every stage):
   · Guardrails: input/output checks + tripwires (immediate stop)
   · Gates: plan approval (front) · completion (back), blocked-first (fail-closed)
   · Observability: tool/reasoning/hierarchy traces + cost + state transitions
   · Recovery: checkpoint resume · idempotency · isolation (worktree)
   · Verification: golden tasks + 6-layer tests grade the harness itself
```

**How to read it:** a task starts with the orchestrator opening **one handoff page** → the
planner fills the plan section → the worker the build section → the evaluator the evaluation
section (a different agent from the worker who built it) → the **curator/learner** reinforces
the strategies that worked and organizes learned procedures to make **the next task better**
(Muse's own self-learning feedback loop). Every stage runs on the **cross-cutting foundations**
of guardrails, gates, observability, and recovery, and the harness itself is checked by
verification (golden tasks, 6 layers).

## 2. Document → component map

| Component | Document |
|---|---|
| Roles, patterns, boundaries (7 roles incl. curator/learner) | [team-roles](../core/team-roles.md) |
| Paste-in prompts per role | [role-prompts](../core/role-prompts.md) |
| Self-learning feedback loop (skills, playbook, retrospective) | [team-roles](../core/team-roles.md) curator/learner + [muse-mapping](../host/muse-mapping.md) |
| Tool design / external tools (skills·MCP) | [tool-design](tool-design.md) · [skills-and-mcp](skills-and-mcp.md) |
| Loop termination & budget / context compaction | [loop-budget](loop-budget.md) · [context-compaction](context-compaction.md) |
| Permission matrix / memory layers | [permission-matrix](../core/permission-matrix.md) · [memory-layers](memory-layers.md) |
| Debugging & DX | [debugging-and-dx](debugging-and-dx.md) |
| Task state (handoff) | [handoff-template](../core/handoff-template.md) |
| Guardrails & gates | [verification-and-guardrails](../core/verification-and-guardrails.md) |
| Failure modes, observability, recovery | [failure-modes-and-observability](failure-modes-and-observability.md) |
| Verifying the harness itself | [harness-acceptance](harness-acceptance.md) |
| Muse runtime mapping | [muse-mapping](../host/muse-mapping.md) |

## 3. Self-assessment — against the 2026 checklist

Current state against the authoritative checklist (awesome-harness-engineering's 12
categories):

| # | Authority category | Our harness | Status |
|---|---|---|---|
| 1 | Agent loop | team-roles patterns + [loop-budget](loop-budget.md) (iteration/time/budget hard caps · circuit breaker) | ✅ |
| 2 | Planning & decomposition | planner role + handoff plan section | ✅ |
| 3 | Context & compaction | [context-compaction](context-compaction.md) — pre-emptive · periodic · budget-aware · importance-weighted preservation (+measured: decisions/sources preserved pass^2) | ✅ |
| 4 | Tool design | [tool-design](tool-design.md) — one-shot selection · example schemas · risk tiers | ✅ |
| 5 | Skills & MCP | [skills-and-mcp](skills-and-mcp.md) — two-stage allowlist · isolation · least privilege · distrusted output | ✅ |
| 6 | Permissions & approval | [permission-matrix](../core/permission-matrix.md) — risk tier × handling · least privilege · audit (+measured: outbound=blocked-first · finance=refused) | ✅ |
| 7 | Memory & state | [memory-layers](memory-layers.md) + handoff status log — 5 layers · write/read/prune (+measured: write rules pass^2) | ✅ |
| 8 | Orchestration | team-roles + muse-mapping | ✅ |
| 9 | Verification & CI | verification + acceptance (6 layers) | ✅ |
| 10 | Observability & traces | failure-modes observability | ✅ |
| 11 | Debugging & DX | [debugging-and-dx](debugging-and-dx.md) — trace → isolate → deterministic replay → regression | ✅ |
| 12 | Human-in-the-loop (HITL) | gates, approvals, check-ins | ✅ |

**One-line conclusion:** **all 12 categories ✅ documented** (⬜ 0 / 🟡 0) **+ many measured
passes with real Claude Code** (evaluator both directions · empty-criteria block · worker
convergence · 3-role chain + permission/memory/compaction gates — including repeated pass^k,
[harness-acceptance §7.5](harness-acceptance.md)). **And now active and portable, not a
reference document**: agents read and follow it via the entrypoint [AGENTS.md](../AGENTS.md)
(this repository links it from the root `AGENTS.md` · `CLAUDE.md`), and via
[INSTALL](../INSTALL.md) the whole `harness/` folder is copied into any project for reuse.

## 4. What to fill next (priority)

1. ~~Tool design contract~~ → [tool-design](tool-design.md) ✅.
2. ~~Skills/MCP integration~~ → [skills-and-mcp](skills-and-mcp.md) ✅.
3. ~~Debugging/DX~~ → [debugging-and-dx](debugging-and-dx.md) ✅.
4. ~~Loop termination & budget~~ → [loop-budget](loop-budget.md) ✅.
5. ~~Context compaction~~ → [context-compaction](context-compaction.md) ✅.
6. ~~Permission matrix~~ → [permission-matrix](../core/permission-matrix.md) ✅ · ~~memory layers~~ → [memory-layers](memory-layers.md) ✅.

**All slots ✅ + active/portable + code enforcement complete:** ① **minimal code runner
implemented & verified** — [runner/](../runner/) enforces the gates as deterministic code, §7
rejection matrix `node --test` **13/13** ② **evaluator human-label calibration** —
[judge-calibration](judge-calibration.md) then n=6 TPR 2/2 · TNR 4/4 → now **n=12 TPR 4/4 · TNR
8/8=100%** (above the typical judge's TNR<25% baseline) ③ **ambiguous golden expansion** — G11
(partial satisfaction) · G12 (semantic bug/TNR).

**Through L4 execution-integration, CI, and adversarial (2026-05-31):** ④ **the runner actually
drives** — [runner/orchestrator.mjs](../runner/orchestrator.mjs) drives plan→build→eval with
code gates using real `claude -p`, end-to-end **3/3 DONE** + traces ⑤ **adversarial 9/9
blocked** (all gate-bypass attempts BLOCKED) ⑥ **CI gate** harness.yml (`node --test` then
27/27 — now 69/69). Maturity: design/evidence/code-enforcement + **execution-integration, CI,
adversarial** reached. **L5 in progress:** real-world tasks G13·G14 actually driven by the
integrated runner (cumulative 5/5 DONE) · judge calibration n=6→**12** (TPR 4/4 · TNR 8/8).
Remaining: large multi-step and real-codebase work, growing the calibration set further +
repeats, expanding trace observability.

**Status against the canonical 5 layers (Boris Cherny/Claude Code):** **permissions**
[permission-matrix](../core/permission-matrix.md)+`permissionGate` code ✅ · **hooks**
[hooks](hooks.md)+`hooks.mjs` code ✅ (PreToolUse un-bypassable · fail-closed) ·
**observability** [observability](observability.md)+`tracer.mjs` code ✅ (correlation ID ·
summary · redaction, orchestrator-wired) — **memory and tools, initially contract-stage, are
also now filled in as code** as below. The additional control-plane element **session
persistence** (checkpoint · resume,
[session-persistence](session-persistence.md)+`session.mjs`) is also code ✅ — a stopped run
resumes without re-executing completed stages. The **memory runtime**
([memory-layers](memory-layers.md)+`memory.mjs`) is also code ✅. The **tool registry**
([tool-design](tool-design.md)+`tools.mjs`: registration · schema validation · allow/deny ·
few-exposed · risk tiers) is also code ✅. → **All canonical 5 layers (memory · tools ·
permissions · hooks · observability) in code + control-plane session persistence.**
**Multi-stage orchestration** ([runner/project.mjs](../runner/project.mjs)) is also code ✅ —
decompose a large task into subtasks → drive each through the gate cycle → synthesize
(map-reduce-and-manage), including **subtask shared context** (earlier output → later input,
`shareContext`). Runner code suite **69/69** + real multi-stage e2e (in-memory TODO decomposed
into 4 → all DONE; **dependency chain** `c_to_f`→`batch_c_to_f` reusing the earlier function to
DONE, real claude).

## Scope — this harness is Claude-Code-only

The Muse harness runs **only on Claude Code**. So some layers of a general production harness
are **delegated to Claude Code, not things we build** (design, not gaps):

- **Sandboxed execution isolation / cost & subscription** — provided by Claude Code. Not our
  responsibility.
- **MCP integration** — only MCP connected to Claude Code is used. Our
  [tool-design](tool-design.md) registry owns only the governance of "what to expose, allow, and
  validate" (we do not build a new MCP client).
- **Parallel, isolated subagents** — leverage Claude Code's **native subagents/agent teams**.
  The harness roles are pinned as real
  `.claude/agents/harness-{planner,worker,evaluator,curator}.md` subagents (least-privilege
  tools · auto-delegation description · model). The evaluator is a different subagent from the
  worker (no write permissions), so maker ≠ judge is enforced by tool permissions too.
  Independent subtasks run in parallel; dependent ones sequentially (consistent with
  `shareContext`). We do not build a new parallel runtime →
  [claude-code-integration](claude-code-integration.md).

→ **Re-scored on a Claude-Code-only basis:** the above are delegations, so excluded from gaps.
The remaining real work was about **subtask dependencies** (completed this round); now
larger-scale, real-codebase verification and repeat samples are the core of completeness.

## 5. The pruning principle (Pruning — harnesses rot too)

**"Every component of the harness encodes an assumption about what the model cannot do on its
own — that assumption is worth stress-testing"** (Anthropic, 2026-03). As models improve, a
part that carried load becomes dead weight — the real case of Sonnet 4.5's context-anxiety
workaround becoming unnecessary on Opus 4.6 (Anthropic managed-agents names this "harness
staleness" as a first-class risk). The reverse direction of filling (§3·§4) is also a
contract:

- **Ablate one component at a time** — remove it, measure the delta with the golden set/runner,
  and delete it if it contributes nothing (applying
  [harness-acceptance §6](harness-acceptance.md)'s "one variable at a time" to *removal* too).
- **Additions come only from failures (the ratchet)** — a new rule/gate line must point to one
  observed failure (Hashimoto "every line of AGENTS.md came from one bad behavior" · Huntley's
  "signs"). A pre-emptive component with no failure evidence is the #1 rot candidate.
- **Model/runtime upgrade = re-audit trigger** — when the base model changes, re-audit the list
  of components that existed to "compensate for model weaknesses" (Osmani: "scaffolding that
  compensated for model weaknesses dies when the model gets better").

> This self-assessment is measured against an external authoritative checklist, and the status
> in the table above is updated as slots are filled. Measurable progress (empty slot → filled)
> is the road to "the best harness" — and it stays that road only when §5's pruning removes at
> the same speed.

## Sources (self-assessment basis)

- [awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) (the 12-category harness checklist)
- Adnan Masood — [Agent Harness Engineering: The Rise of the AI Control Plane](https://medium.com/@adnanmasood/agent-harness-engineering-the-rise-of-the-ai-control-plane-938ead884b1d) (15-module component model · risk taxonomy)
- Atlan — [Best AI Agent Harness Tools 2026](https://atlan.com/know/best-ai-agent-harness-tools-2026/)
- Braintrust — [Agent Observability 2026](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026)
- Anthropic — [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (context reset · structured handoff · compaction)
- Anthropic — [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) (2026-03; "every component is an assumption about what the model can't do" — remove one component at a time and measure impact) · [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) (2026-04; harness staleness — workarounds turned dead weight by model improvement)
- Mitchell Hashimoto — [My AI Adoption Journey](https://mitchellh.com/writing/my-ai-adoption-journey) (2026-02; naming Agent = Model + Harness, AGENTS.md = failure-catalog ratchet)
- [AGENTS.md](https://agents.md/) — OpenAI-originated · Linux Foundation standard, the cross-tool agent-instruction format adopted by 60k+ repos (the entrypoint format of this harness)
- Addy Osmani — [Agent Harness Engineering](https://addyosmani.com/blog/agent-harness-engineering/) ("a configuration problem, not a model problem" — ~60% of agent failures originate in the harness)
- Cognition — [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) → [Multi-Agents: What's Actually Working](https://cognition.ai/blog/multi-agents-working) (2026: writes on a single thread; auxiliary agents add intelligence not action — map-reduce-and-manage)
- Hamel Husain — [Using LLM-as-a-Judge](https://hamel.dev/blog/posts/llm-judge/) (calibrate the judge against human labels)
- OpenAI — [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/) (deterministic scaffolding · structural gates · ~100-line AGENTS.md map · harness > model)
- Andrej Karpathy — [agentic engineering / autonomy slider](https://www.nextbigfuture.com/2026/03/andrej-karpathy-on-code-agents-autoresearch-and-the-self-improvement-loopy-era-of-ai.html) ("evals before more permissions" · autonomy slider · tight leash)
- Boris Cherny (creator of Claude Code) — [workflow/harness](https://karozieminski.substack.com/p/boris-cherny-claude-code-workflow) (thin harness · smart model · loop-centric; Claude Code's 5 harness layers)
- [Faramesh: protocol-agnostic execution control plane](https://arxiv.org/pdf/2601.17744) (non-bypassable · fail-closed permissions — the basis for codifying gates)
