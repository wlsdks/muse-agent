---
title: Muse documentation guide (index)
audience: [planners, developers, AI agents]
purpose: Single entry point to the Muse documentation set — which document holds what
updated: 2026-07-30
related: [strategy/attunement.md, design/attunement-graph.md, ../internal/goals/attunement-wow-graph-roadmap.md, product/SYSTEM-MAP.md, product/FEATURES.md]
---

# Muse documentation guide

The Muse docs are kept "only what's needed, short, well separated." If you're new, reading just
**[SYSTEM-MAP](product/SYSTEM-MAP.md)** gives you the whole outline.

> **Language rule:** every document in this repository is written in **English**. The only
> exception is quoted material — UI strings, CLI output samples, and user utterances may stay in
> their original language, marked as quotes.

## How this folder is organised

Every document lives in exactly one topic folder, and the folder name says which question it answers:

| Folder | Answers |
|---|---|
| [`product/`](product/) | What Muse is and does — [SYSTEM-MAP](product/SYSTEM-MAP.md), [FEATURES](product/FEATURES.md), [glossary](product/glossary.md) |
| [`trust/`](trust/) | Why you can believe the output — [grounding-gate](trust/grounding-gate.md), [privacy-and-data](trust/privacy-and-data.md) |
| [`setup/`](setup/) | Getting it running — [local LLM](setup/setup-local-llm.md), [env inventory](setup/ENV.md), [remote access](setup/remote-access.md) |
| [`architecture/`](architecture/README.md) | How it is built, and the decisions behind it — plus [`adr/`](architecture/adr/) |
| [`design/`](design/) | Per-feature design rationale: why a shipped thing is shaped that way |
| [`strategy/`](strategy/) | Product direction and positioning |
| [`development/`](development/) | How we verify and release |
| [`evaluations/`](evaluations/) · [`benchmarks/`](benchmarks/) · [`feature-catalog/`](feature-catalog/) | Dated evidence, kept as records rather than rewritten |

Work ledgers and autonomous-loop journals are not documentation and live outside this tree, in
[`../internal/goals/`](../internal/goals/).

## If you are an AI agent (Claude Code · Codex) — read in this order

The recommended reading order so an agent opening the repo for the first time can **understand Muse
from docs alone**:

1. [`../README.md`](../README.md) — what Muse is (identity, Continuity, current status boundary)
2. [`../CLAUDE.md`](../CLAUDE.md) — the contract every agent reads first (non-negotiable rules)
3. [`strategy/attunement.md`](strategy/attunement.md) — the product promise and the current/roadmap boundary
4. [`product/glossary.md`](product/glossary.md) — Muse-specific terms (Attunement, Observe, grounding floor… without grep)
5. [`product/SYSTEM-MAP.md`](product/SYSTEM-MAP.md) — the feature structure on one page
6. [`trust/grounding-gate.md`](trust/grounding-gate.md) — the trust floor (grounding gate) as one flow
7. [`product/FEATURES.md`](product/FEATURES.md) → [`feature-catalog/INDEX.md`](feature-catalog/INDEX.md) — feature detail + exhaustive verification evidence
8. Then go deeper: [`design/attunement.md`](design/attunement.md) · [`design/attunement-graph.md`](design/attunement-graph.md) · [`goals/attunement-implementation-plan.md`](../internal/goals/attunement-implementation-plan.md) · [`goals/attunement-wow-graph-roadmap.md`](../internal/goals/attunement-wow-graph-roadmap.md) · [`design/`](design/) · [`strategy/`](strategy/) · [`../.claude/rules/`](../.claude/rules/) · [`../harness/`](../harness/README.md)

## To understand the product

| Document | What | For whom |
|---|---|---|
| **[strategy/attunement.md](strategy/attunement.md)** | Muse's wedge, user moments, current/experimental/roadmap boundary | Product, design, and dev alike |
| **[design/attunement.md](design/attunement.md)** | The privacy and closed-loop technical contract of the implemented Slice A and the follow-on Observe | Dev, security, AI agents |
| **[design/attunement-graph.md](design/attunement-graph.md)** | Module contract and research basis of the agent-native time/provenance graph and personal context compiler | Product, dev, security |
| **[goals/attunement-implementation-plan.md](../internal/goals/attunement-implementation-plan.md)** | Dependency-ordered vertical slices, gates, kill criterion | Execution and evaluation owners |
| **[goals/attunement-wow-graph-roadmap.md](../internal/goals/attunement-wow-graph-roadmap.md)** | The separate long-horizon execution order for Shadow Muse, Capsule, Policy Card, Graph Engine | Execution and evaluation owners |
| **[SYSTEM-MAP.md](product/SYSTEM-MAP.md)** | Structural map of Muse's features at a glance (words only, for quick orientation) | Planners and devs / first-time readers |
| **[glossary.md](product/glossary.md)** | Single definition of Muse-specific terms (one line per term + where it lives) | First-time readers / AI agents |
| **[grounding-gate.md](trust/grounding-gate.md)** | How the grounding gate — the trust floor — handles one question: flow + worked example | Anyone who wants the core behavior / AI agents |
| **[FEATURES.md](product/FEATURES.md)** | Per-feature detailed definitions (what, and how it behaves from the user's perspective) | Product and design decisions |
| **[feature-catalog/INDEX.md](feature-catalog/INDEX.md)** | Exhaustively verified full feature inventory (run/test/source evidence per feature; 2026-06-14) | Anyone who needs exact facts / AI agents |
| **[privacy-and-data.md](trust/privacy-and-data.md)** | Where data lives and what each privacy posture blocks | People checking before adopting |

## To run it yourself

| Document | What |
|---|---|
| **[setup-local-llm.md](setup/setup-local-llm.md)** | Installation guide for running Muse on a local LLM (Ollama etc.) |
| **[guides/remote-access.md](setup/remote-access.md)** | `muse remote enable` — open the Muse web UI from your phone via Tailscale (tailnet-only) |

## Deeper — design notes

The [`design/`](design/) folder holds design notes for individual features, one file per topic. Most
are **the design rationale for features already shipped** (why it was built that way);
[background-review-engine](design/background-review-engine.md) is the one design currently in
progress. For a feature's "what," see the product docs above; for the "why," look here:

- Attunement: [architecture and data contract](design/attunement.md), [graph engine](design/attunement-graph.md), [implementation slices](../internal/goals/attunement-implementation-plan.md), [wow + graph roadmap](../internal/goals/attunement-wow-graph-roadmap.md), [continuity-timing-loop](design/continuity-timing-loop.md), [muse-work](design/muse-work.md)
- Memory and perception: [episodic-memory](design/episodic-memory.md), [proactive-surfacing](design/proactive-surfacing.md), [pattern-detection](design/pattern-detection.md), [context-engineering-roadmap](design/context-engineering-roadmap.md), [resumable-notes-indexing](design/resumable-notes-indexing.md)
- Proactivity and follow-up: [agent-self-followup](design/agent-self-followup.md), [reminder-firing](design/reminder-firing.md), [background-review-engine](design/background-review-engine.md), [progressive-autonomy-p0](design/progressive-autonomy-p0.md)
- Channels and voice: [messaging](design/messaging.md), [line-webhook](design/line-webhook.md), [voice-mode](design/voice-mode.md), [phase-d-chat-stream-routing](design/phase-d-chat-stream-routing.md)
- Action and platform: [actuator-modes](design/actuator-modes.md), [macos-control](design/macos-control.md), [a2a-swarm](design/a2a-swarm.md), [mascot](design/mascot.md)

## Agent harness (operating structure)

[`../harness/`](../harness/README.md) — the team composition, roles, and handoff definitions that
let any AI agent collaborate the same way (based on multi-agent patterns verified 2026-05). **For
the current setup at a glance → [diagram & self-assessment (architecture)](../harness/reference/architecture.md)**
(one-page diagram + 12-cell self-assessment + doc map). Role definitions:
[team-roles](../harness/core/team-roles.md).

## Autonomous expansion loops (operations)

These documents are the operating machinery of the autonomous loops that expand Muse itself (not
product-feature descriptions):

- [`goals/`](../internal/goals/) — work ledgers (backlog · growth-backlog · rival-watch) and active loop journals — map at [`goals/README.md`](../internal/goals/README.md)

---

> Housekeeping principle: don't pile everything into one document. A new topic is added as a
> **small new document + one link line in this index**, and giant plan/audit records already
> shipped and absorbed into the main docs are removed and left to git history.
