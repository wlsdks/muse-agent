---
title: Debugging & Developer Experience (Debugging & DX)
audience: [developers, AI agents]
purpose: The flow that turns non-deterministic agent failures into something a human can read, reproduce, fix, and lock in against regression
status: draft
updated: 2026-05-31
sources_basis: [Muse SYSTEM-MAP #12 (traces + failure replay), Braintrust agent observability 2026, Maxim debugging AI agents 2026, deterministic replay / time-travel debugging 2026]
related: [failure-modes-and-observability.md, harness-acceptance.md, ../core/verification-and-guardrails.md, architecture.md, ../README.md]
---

# Debugging & Developer Experience (Debugging & DX)

> **Why was this the last gap?** The last ⬜ of the [architecture](architecture.md)
> self-assessment. Agents are **non-deterministic** — the same input can behave differently every
> time — so even with observability
> ([failure-modes-and-observability](failure-modes-and-observability.md)), debugging stalls
> without "how do I reproduce this to fix it". Muse already has **traces + failure replay**
> (below), so this document organizes the flow a human uses to handle failures on top of that.
> Prose only (no code).

## 0. The one-line principle

**Leave every run as a reproducible trace; fix failures by deterministically replaying from that
trace; then harden the fixed case into a regression test.** Not guess-debugging — "run it again
under the same conditions".

## 1. The foundation for reproduction (what already exists)

The Muse runtime already has per-stage run records (traces) and failure replay (debug replay)
(SYSTEM-MAP #12). Harness debugging layers on top:
- Each stage (span) records input, output, duration, cost, and error state.
- Tool calls record name, arguments, raw output, and retry count
  ([failure-modes-and-observability §2](failure-modes-and-observability.md)).

## 2. The 5-step flow for fixing a failure

1. **Capture every run as a reproducible trace** — recorded routinely, not switched on only after
   a failure occurs.
2. **Isolate the smallest failing section** — narrow down which stage (which worker, which tool
   call) went wrong.
3. **Reproduce deterministically** — feed the recorded model/tool outputs back verbatim,
   replaying the same failure without calling the model again (same conditions = real root-cause
   tracing).
4. **Fix and re-run against the same trace** — confirm the fix actually makes that case pass.
5. **Convert the fixed case into a regression test** — permanently absorbed into the golden tasks
   / regression suite of [harness-acceptance](harness-acceptance.md) (layer 5 of the 6) — so the
   same failure cannot recur.

## 3. Tracking across multiple agents (correlation ID)

- When a failure spreads across multiple agents, finding the root cause is hard.
- Let **one correlation ID run through every agent and tool call**, so a single user request is
  traceable end to end.
- Span parent-child hierarchy must survive across handoffs, so you can see at which stage things
  diverged.

## 4. Human-readable (DX)

- Show traces as a **hierarchy tree** (orchestrator → worker → tool) so the flow reads at a
  glance.
- The failed stage must reveal **what went wrong and why** in one line (with links to the raw
  inputs/outputs).
- The handoff form's `## Status log` (append-only) and `## Open questions` are the entry points
  for human debugging ([handoff-template](../core/handoff-template.md)).

## 5. One-line summary (debugging checklist)

1. Does every run leave a **reproducible trace**?
2. On failure, do you narrow to the **smallest section**?
3. Can you **reproduce deterministically** from recorded outputs (no model re-call)?
4. Does the fixed case harden into a **regression test**?
5. Does a **correlation ID** run through the multi-agent flow end to end?

---

## Sources (verified basis)

- Muse product — SYSTEM-MAP #12 (per-stage run traces + failure replay, code-verified)
- Braintrust — [Agent Observability 2026](https://www.braintrust.dev/articles/agent-observability-complete-guide-2026) (nested spans · parent-child · failure↔span mapping)
- Maxim — [Debugging AI Agents in 2026](https://www.getmaxim.ai/articles/debugging-ai-agents-in-2026-tools-techniques-and-best-practices/) (reproduce + isolate workflow)
- [The Debugging Crisis in Multi-Agent AI Systems](https://www.kdnuggets.com/the-debugging-crisis-in-multi-agent-ai-systems-and-how-to-fix-it) (end-to-end tracking via correlation ID)
