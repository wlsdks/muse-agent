---
title: Agent Harness
audience: [planners, developers, AI agents]
purpose: The document set of the operating structure that makes any agent work the same way, whichever one comes in
status: draft
updated: 2026-06-13
related: [core/team-roles.md, ../README.md]
---

# Agent Harness

This folder collects the operating structure that makes **whichever AI agent is put on Muse work
collaborate the same way**. Based on multi-agent patterns verified as of May 2026 (Anthropic ·
Addy Osmani · Cognition · OpenAI).

> **This one folder IS the harness.** It is self-contained, so copy it into any project.
> - **If you are an agent → read [AGENTS.md](AGENTS.md) and follow it** (operating contract · entrypoint).
> - **To install in a new project → [INSTALL.md](INSTALL.md)** (copy + one connecting line + swap the mapping).
> - The table below is the human-facing index.

## Portable structure — many documents, but only one page is ever read

The only thing an agent **always reads is the one page [AGENTS.md](AGENTS.md)**; the rest are
references entered through links when needed (progressive disclosure — no agent reads everything,
nor should it). When taking the harness to a new project, choose by tier:

The tiers ARE the **folder structure**:

| Folder | Tier | What |
|---|---|---|
| `AGENTS.md` (root) | Entrypoint | The single page every agent always reads |
| [`core/`](core/) | **T1 core contract (minimal install)** | handoff-template · role-prompts · team-roles · verification-and-guardrails · permission-matrix — copying AGENTS.md + these 5 alone gives a working instruction-layer harness |
| [`reference/`](reference/) | **T2 operating reference (full install)** | loop-budget · context-compaction · memory-layers · tool-design · skills-and-mcp · failure-modes · debugging-and-dx · hooks · observability · session-persistence · claude-code-integration · architecture · judge-calibration · runner-spec · harness-acceptance (method) · golden-set (frame) — followed by link when depth is needed |
| [`runner/`](runner/) | **T3 enforcement layer (optional)** | Gates as deterministic code — only when headless automation / code-level proof is needed ([AGENTS.md §3.5](AGENTS.md)) |
| [`host/`](host/) | **Per-host swap/reset** | muse-mapping (→ replace with your project's mapping) · dev-loop (host development loop — rewrite). The golden-set progress table and the measurement *records* of harness-acceptance §7.5 are also emptied in a new project and rebuilt from scratch |
| [`templates/`](templates/) | **Bundled export copies** | The 4 Claude Code role subagents (planner/worker/evaluator/curator) — copy into the new project's `.claude/agents/` ([INSTALL §4](INSTALL.md)) |

**Status (2026-06-13):** all 12 authoritative categories **documented (✅)** + the orthodox 5 layers
(permissions · hooks · observability · memory · tools) **all in code** (runner suite 69/69,
adversarial 9/9 blocked, CI gate) + golden set **G1~G14 fully measured** (pass^k up to 10,
[harness-acceptance §7.5](reference/harness-acceptance.md) ~39 recorded runs) + judge calibration
n=12 TPR/TNR 100%. Remaining: large real-codebase multi-stage measurement, calibration-set
expansion and repetition. (Individual document frontmatter stays draft.)

| Document | What | Status |
|---|---|---|
| [team-roles.md](core/team-roles.md) | The team's roles, boundaries, handoffs, and verification gates (vendor-neutral) | draft |
| [handoff-template.md](core/handoff-template.md) | The single handoff-artifact form filled and passed on per task | draft |
| [role-prompts.md](core/role-prompts.md) | The vendor-neutral system-prompt block attached per role | draft |
| [muse-mapping.md](host/muse-mapping.md) | Abstract roles ↔ Muse's real multi-agent runtime parts (what is possible right now) | draft |
| [verification-and-guardrails.md](core/verification-and-guardrails.md) | Evaluator grading rubric · input/output guardrails · gate/observability/recovery rules | draft |
| [failure-modes-and-observability.md](reference/failure-modes-and-observability.md) | Where the harness breaks (~60% is the harness's fault) · minimal observability · recovery · judge calibration | draft |
| [harness-acceptance.md](reference/harness-acceptance.md) | How to verify the harness "actually worked well" — golden tasks · outcome+path · 6-layer tests · document self-check | draft |
| [golden-set.md](reference/golden-set.md) | The fixed task set (G1~G14) that builds confidence through measurement + pass^k progress | draft |
| [runner-spec.md](reference/runner-spec.md) | The execution contract that raises handoffs/gates from "human-filled" to "runtime-enforced" | draft |
| [runner/](runner/) | **Code runner** — gates, loops, and hooks enforced as deterministic code (`node --test "harness/runner/*.test.mjs"` 69/69) | code |
| [hooks.md](reference/hooks.md) | The **hook** layer (PreToolUse/PostToolUse) — block or observe tool calls non-bypassably | draft |
| [observability.md](reference/observability.md) | The **observability** layer — correlation-ID traces · summaries (cost/steps) · redaction | draft |
| [session-persistence.md](reference/session-persistence.md) | **Session persistence** — checkpoint · resume (without re-running completed stages) | draft |
| [claude-code-integration.md](reference/claude-code-integration.md) | **Claude Code integration** — subagents · agent teams · Dynamic Workflows + the orchestration-mode selection convention (just-work/sub/team/workflow) | draft |
| [judge-calibration.md](reference/judge-calibration.md) | Calibrate the evaluator against human labels (TPR/TNR) — numeric proof that invalid-detection is strong | draft |
| [architecture.md](reference/architecture.md) | **Diagram (one page)** + self-assessment against the 2026 authoritative checklist (what exists, what is missing) | draft |
| [tool-design.md](reference/tool-design.md) | How to design and expose tools so the right one is chosen in one shot (one-shot selection · example-bearing schemas · risk tiers) | draft |
| [skills-and-mcp.md](reference/skills-and-mcp.md) | The convention for safely pulling in external tools (MCP) and self-authored skills (two-stage allowlist · isolation · least privilege · untrusted output) | draft |
| [debugging-and-dx.md](reference/debugging-and-dx.md) | The flow that fixes non-deterministic failures via trace → isolate → deterministic repro → regression | draft |
| [loop-budget.md](reference/loop-budget.md) | Hard caps on iterations, time, and budget + circuit breaking so loops end without infinite repetition or cost blowout | draft |
| [context-compaction.md](reference/context-compaction.md) | Shrink so the context window never overflows, but preserve decisions and sources (pre-emptive · periodic · budget-aware · importance-weighted) | draft |
| [permission-matrix.md](core/permission-matrix.md) | Risk tier × handling (pass/trust/approve/refuse) matrix + least privilege + audit | draft |
| [memory-layers.md](reference/memory-layers.md) | The 5 layers — working, short-term, long-term, user model, episodic — + write/read/consolidate/promote/decay | draft |

## When a new agent joins (how to use the skeleton)

1. Pick your **one role** via the [team-roles §7](core/team-roles.md) checklist.
2. Attach that role's block from [role-prompts](core/role-prompts.md) to your system prompt.
3. Fill **only your own section** of the [handoff-template](core/handoff-template.md) form and pass
   it to the next role.

> The executable form of the verification gates (completion hooks · checkpoints) is codified in
> [runner/](runner/). For the Muse runtime mapping, see [muse-mapping](host/muse-mapping.md).
