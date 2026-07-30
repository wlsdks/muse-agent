---
title: Muse documentation guide (index)
audience: [AI agents]
purpose: Where to look for what — written for the agents that do the work here
updated: 2026-07-30
related: [strategy/attunement.md, design/attunement/attunement-graph.md, ../internal/goals/attunement-wow-graph-roadmap.md, product/SYSTEM-MAP.md, product/FEATURES.md]
---

# Muse documentation guide

**Assume the reader is an agent.** Muse is built by agentic coding: agents do the work, and the
owner reads their replies rather than these files. So these documents optimise for an agent that
needs an exact fact fast — one owner per fact, paths that resolve, claims that match the code —
not for onboarding a person. The public [`README.md`](../README.md) is the exception; it is the
one page written for a human visitor.

Three consequences worth stating, because they change what belongs here:

- **English only.** Quoted material — UI strings, CLI output, user utterances — may stay in its
  original language, marked as a quote.
- **A document that no longer matches the code is worse than a missing one**, because an agent
  will ground on it. Stale records get deleted rather than annotated; git history keeps them.
- **One owner per fact.** If a gate enforces something, the doc points at the gate instead of
  restating the rule where it can drift.

## How this folder is organised

Every document lives in exactly one topic folder, and the folder name says which question it answers:

| Folder | Answers |
|---|---|
| [`product/`](product/) | What Muse is and does — [SYSTEM-MAP](product/SYSTEM-MAP.md), [FEATURES](product/FEATURES.md), [glossary](product/glossary.md) |
| [`trust/`](trust/) | Why you can believe the output — [grounding-gate](trust/grounding-gate.md), [privacy-and-data](trust/privacy-and-data.md) |
| [`setup/`](setup/) | Getting it running — [local LLM](setup/setup-local-llm.md), [env inventory](setup/ENV.md), [remote access](setup/remote-access.md) |
| [`architecture/`](architecture/README.md) | How it is built, and the decisions behind it — plus [`adr/`](architecture/adr/) |
| [`design/`](design/) | Per-feature design rationale, grouped `attunement/` · `memory/` · `proactive/` · `channels/` · `platform/` |
| [`strategy/`](strategy/) | Product direction — the [Attunement contract](strategy/attunement.md) at the top, with [`positioning/`](strategy/positioning/) (differentiation, competitive reads) and [`research/`](strategy/research/) (agent principles, context doctrine, prompt architecture) |
| [`development/`](development/) | How we verify and release |
| [`evaluations/`](evaluations/) · [`benchmarks/`](benchmarks/) | Dated evidence, kept as records rather than rewritten |

Work ledgers and autonomous-loop journals are not documentation and live outside this tree, in
[`../internal/goals/`](../internal/goals/).

## Cold start — the shortest path to a working model of Muse

If you have no context at all, read these in order; each one is a prerequisite for the next. Stop
as soon as you can answer the question you came for.

1. [`../README.md`](../README.md) — what Muse is (identity, Continuity, current status boundary)
2. [`../CLAUDE.md`](../CLAUDE.md) — the contract every agent reads first (non-negotiable rules)
3. [`strategy/attunement.md`](strategy/attunement.md) — the product promise and the current/roadmap boundary
4. [`product/glossary.md`](product/glossary.md) — Muse-specific terms (Attunement, Observe, grounding floor… without grep)
5. [`../CONTEXT.md`](../CONTEXT.md) — the same domain language as architecture invariants, plus the one-way dependency direction between modules
6. [`product/SYSTEM-MAP.md`](product/SYSTEM-MAP.md) — the feature structure on one page
7. [`trust/grounding-gate.md`](trust/grounding-gate.md) — the trust floor (grounding gate) as one flow
8. [`product/FEATURES.md`](product/FEATURES.md) — per-feature detail, and [`benchmarks/EVIDENCE.md`](benchmarks/EVIDENCE.md) for what is actually proven
9. Then go deeper: [`design/attunement/README.md`](design/attunement/README.md) · [`design/attunement/attunement-graph.md`](design/attunement/attunement-graph.md) · [`../internal/goals/attunement-implementation-plan.md`](../internal/goals/attunement-implementation-plan.md) · [`../internal/goals/attunement-wow-graph-roadmap.md`](../internal/goals/attunement-wow-graph-roadmap.md) · [`design/`](design/) · [`strategy/`](strategy/) · [`../.claude/rules/`](../.claude/rules/) · [`../.claude/harness/contract.md`](../.claude/harness/contract.md)

## To understand the product

| Document | What it owns |
|---|---|
| **[strategy/attunement.md](strategy/attunement.md)** | Muse's wedge, user moments, current/experimental/roadmap boundary |
| **[design/attunement/README.md](design/attunement/README.md)** | The privacy and closed-loop technical contract of the implemented Slice A and the follow-on Observe |
| **[design/attunement-graph.md](design/attunement/attunement-graph.md)** | Module contract and research basis of the agent-native time/provenance graph and personal context compiler |
| **[goals/attunement-implementation-plan.md](../internal/goals/attunement-implementation-plan.md)** | Dependency-ordered vertical slices, gates, kill criterion |
| **[goals/attunement-wow-graph-roadmap.md](../internal/goals/attunement-wow-graph-roadmap.md)** | The separate long-horizon execution order for Shadow Muse, Capsule, Policy Card, Graph Engine |
| **[SYSTEM-MAP.md](product/SYSTEM-MAP.md)** | Structural map of Muse's features at a glance (words only, for quick orientation) |
| **[glossary.md](product/glossary.md)** | Single definition of Muse-specific terms (one line per term + where it lives) |
| **[grounding-gate.md](trust/grounding-gate.md)** | How the grounding gate — the trust floor — handles one question: flow + worked example |
| **[FEATURES.md](product/FEATURES.md)** | Per-feature detailed definitions (what, and how it behaves from the user's perspective) |
| **[privacy-and-data.md](trust/privacy-and-data.md)** | Where data lives and what each privacy posture blocks |

## To run it yourself

| Document | What |
|---|---|
| **[setup-local-llm.md](setup/setup-local-llm.md)** | Installation guide for running Muse on a local LLM (Ollama etc.) |
| **[guides/remote-access.md](setup/remote-access.md)** | `muse remote enable` — open the Muse web UI from your phone via Tailscale (tailnet-only) |

## Deeper — design notes

[`design/`](design/) holds the rationale for individual features — mostly *why a shipped thing is
shaped the way it is*. It is grouped the same way the runtime is, so a design note sits next to the
others it interacts with:

| Folder | Notes |
|---|---|
| [`design/attunement/`](design/attunement/README.md) | The architecture and data contract, the [graph engine](design/attunement/attunement-graph.md) and its [core](design/attunement/agent-native-graph-core.md), [continuity-timing-loop](design/attunement/continuity-timing-loop.md), [observe-o1](design/attunement/observe-o1.md), [muse-work](design/attunement/muse-work.md) |
| [`design/memory/`](design/memory/) | [episodic-memory](design/memory/episodic-memory.md), [context-engineering-roadmap](design/memory/context-engineering-roadmap.md), [resumable-notes-indexing](design/memory/resumable-notes-indexing.md), [background-review-engine](design/memory/background-review-engine.md) — the one design still in progress |
| [`design/proactive/`](design/proactive/) | [proactive-surfacing](design/proactive/proactive-surfacing.md), [pattern-detection](design/proactive/pattern-detection.md), [reminder-firing](design/proactive/reminder-firing.md), [agent-self-followup](design/proactive/agent-self-followup.md), [progressive-autonomy-p0](design/proactive/progressive-autonomy-p0.md) |
| [`design/channels/`](design/channels/) | [messaging](design/channels/messaging.md), [line-webhook](design/channels/line-webhook.md), [voice-mode](design/channels/voice-mode.md), [phase-d-chat-stream-routing](design/channels/phase-d-chat-stream-routing.md), [a2a-swarm](design/channels/a2a-swarm.md) |
| [`design/platform/`](design/platform/) | [actuator-modes](design/platform/actuator-modes.md), [macos-control](design/platform/macos-control.md), [mascot](design/platform/mascot.md) |

For a feature's "what", see the product docs above; for the "why", look here.

## Agent harness (operating structure)

[`../.claude/harness/contract.md`](../.claude/harness/contract.md) — the operating contract every
agent follows: risk tiering, the two mandatory roles, the fail-closed gates, and how a slice is
verified. Role definitions and the maker/evaluator write boundaries:
[`roles.md`](../.claude/harness/roles.md). Muse's own day-to-day loop:
[`dev-loop.md`](../.claude/harness/dev-loop.md).

## Autonomous expansion loops (operations)

These documents are the operating machinery of the autonomous loops that expand Muse itself (not
product-feature descriptions):

- [`goals/`](../internal/goals/) — work ledgers (backlog · growth-backlog · rival-watch) and active loop journals — map at [`../internal/goals/README.md`](../internal/goals/README.md)

---

> Housekeeping principle: don't pile everything into one document. A new topic is added as a
> **small new document + one link line in this index**, and giant plan/audit records already
> shipped and absorbed into the main docs are removed and left to git history.
