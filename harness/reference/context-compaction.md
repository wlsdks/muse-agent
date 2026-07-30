---
title: Context Compaction
audience: [developers, AI agents]
purpose: Keeping the finite context window from overflowing — what to reduce when, and what must never be lost
status: draft
updated: 2026-06-13
sources_basis: [Muse context-engineering-roadmap Phase 5 (importance-weighted compaction), Muse episodic compressed summaries, Anthropic multi-agent (subagent 1-2K token summaries), 2026 context compression governance refs]
related: [loop-budget.md, failure-modes-and-observability.md, ../core/team-roles.md, architecture.md, ../README.md]
---

# Context Compaction

> **Why this slot?** A slot that was empty in the [architecture](architecture.md)
> self-assessment (now ✅). The context window is finite but long tasks keep growing their
> context — overflow makes the model timid near the limit or lose information
> ([failure-modes §1 context rot](failure-modes-and-observability.md)). And **context is cost**
> ([loop-budget §4](loop-budget.md)), so reducing it is both a stability and a cost problem.
> Muse already has importance-weighted compaction (below), so this organizes "what, when, and
> how to reduce" as a contract on top. Prose only (no code).

## 0. The one-line principle

**Reduce rather than merge, but never lose decisions.** Don't carry the whole context blindly;
reduce pre-emptively before the limit, but preserve **key facts, events, and decisions**.
(Reduce before splitting into parallel — the single-thread principle of [team-roles §0].)

## 1. When to reduce (triggers)

- **Before the limit, pre-emptively — using the 'dumb zone' as the line.** In field data
  (~100k dev sessions), recall/reasoning degrade **from the point the context window is ~40%
  full** (Horthy "dumb zone") — set the pre-emptive compaction line well before half the window.
- **Periodically** — scheduling compaction every 10–15 tool calls saves tokens substantially
  while preserving quality.
- **Fold at structural boundaries** — folding at **subtask boundaries** (branch → completion
  summary) beats a token threshold (context-folding: 10× active-context reduction at equal
  performance, 2510.11967). Our [project.mjs](../runner/project.mjs) subtask synthesis with
  1–2K compressed returns is that shape.
- **Budget-aware** — as remaining budget tightens (HIGH→CRITICAL), reduce more aggressively
  (meshes with [loop-budget](loop-budget.md)).

## 2. What to keep (selective preservation)

- **Importance weighting** — score each message's importance, drop **lowest first**, keep the
  high ones (active work, decisions, unresolved items). Muse actually supports this
  importance-weighted compaction (chronological by default, importance-ordered as an option).
- **Preserve tool pairs** — never break the pairing of a tool call and its result.
- **Summarize the essentials** — don't discard old conversation; summarize it into **events,
  decisions, and key facts**.

## 3. How to reduce (techniques)

- **Summarization** — replace past sections with a compressed summary. Muse produces a
  compressed summary when a session ends, and that summary is retrieved again later by recall
  (episodic).
- **Pruning** — drop low-importance messages.
- **Subagent compression** — workers operate in their own isolated windows and return **only a
  1–2K-token compressed summary** to the conductor (matches the compressed returns of
  [team-roles §3] — information never floods the main window).
- **Externalize** — when volume is large, write to an external file / the handoff form instead
  of conversation history and point with a link.

## 4. What must never be lost (governance — the risks of compaction)

- Compaction **does not fix noise, staleness, or conflicts** — check context quality before
  reducing.
- Indiscriminate compaction **erases the details and sources that were making answers right**.
  Preserve the sources behind citations so "showing your work" (citability) doesn't break
  ([the-edge] — see SYSTEM-MAP).
- Compaction is effective only when **explicitly scheduled** — "it'll forget on its own" leads
  to quality loss.
- **The compaction result is itself subject to verification** — compaction whose summary is
  checked for preserving decisions, sources, and forward intent beats blind summarization by
  +8.8pp accuracy (Slipstream 2605.08580). The §4.5 measurement (pass^2) is the manual form of
  that check — every compaction must answer "decisions and sources preserved?" and pass before
  it replaces anything.
- **For long work exceeding the context window, compaction alone is not enough** (Anthropic
  effective-harnesses: "compaction isn't sufficient") — you need **structural state** like
  feature lists and progress files → [session-persistence](session-persistence.md).

## 4.5 Measured (compaction preservation rules verified with real Claude Code, 2026-05-31)

Compaction's core risk is **erasing decisions and sources while reducing** (§4 governance). We
gave it a log mixing chit-chat and decisions, had it compact, and watched what it kept and
dropped.

- **Input:** a conversation log where two decisions with rationale are buried among weather and
  lunch chit-chat — ① "deploys are fixed at Tuesdays 10:00 (basis: infra team meeting notes)"
  ② "no Friday deploys (basis: retro on 3 past incidents)".
- **Result (identical over 2 repeats):** both decisions preserved **verbatim including their
  rationale (sources)**; all weather/lunch chit-chat removed. pass^2. Both "reduce but never
  lose decisions" and "preserve citation sources" held.

> Meaning: evidence that compaction **actually discards only noise and keeps decisions +
> sources**, not just on paper. The §4 risk of indiscriminate compaction erasing correct details
> and sources did not occur in measurement.
> [harness-acceptance §7.5](harness-acceptance.md).

## 5. One-line summary (compaction checklist)

1. Do you reduce **before** the limit + **periodically** (every 10–15 calls) +
   **budget-aware**?
2. **Importance-weighted**, lowest first, preserving tool pairs and decisions?
3. Do old sections survive as **event/decision summaries** (not wholesale discard)?
4. Do subagents return **only 1–2K compressed summaries**?
5. Does compaction avoid erasing **sources and correct details** (governance)?

---

## Sources (verified basis)

- Muse design — `docs/design/context-engineering-roadmap.md` Phase 5 (importance-weighted compaction: drop lowest first, preserve tool pairs, chronological default / importance-ordered option — Shipped)
- Muse product — SYSTEM-MAP #5/#6 (session compressed summaries → episodic recall, duplicate-memory cleanup)
- Anthropic — [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (subagent 1–2K token compressed summaries · externalize to files)
- Atlan — [Context Compression: Techniques, Risks, Governance 2026](https://atlan.com/know/context-compression/) (6 summarization/pruning techniques + governance risks)
- [Context compaction in agent frameworks 2026](https://dev.to/crabtalk/context-compaction-in-agent-frameworks-4ckk) (pre-emptive/periodic compaction, budget-aware)
- Dex Horthy/HumanLayer — [RPI·dumb zone](https://linearb.io/dev-interrupted/podcast/dex-horthy-humanlayer-rpi-methodology-ralph-loop) (~100k sessions: degradation from ~40% window — deliberate pre-emptive compaction)
- [Context-Folding (2510.11967)](https://arxiv.org/abs/2510.11967) (subtask-boundary folding, active context 10×↓) · [Slipstream (2605.08580)](https://arxiv.org/abs/2605.08580) (verified compaction +8.8pp) · Anthropic — [Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (long-running work needs structural state — compaction alone insufficient)
