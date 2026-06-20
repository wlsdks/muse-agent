# Muse's context doctrine — context for a continuous companion, not a task session

**The one line:** A coding agent assembles context around a *task*; Muse assembles
context around a *person, over time* — and every assembled token must be **groundable
and citable**, or it does not go in.

This doc is the concept the context-strategy loop builds toward. It is written because
the public state of the art (Anthropic, OpenAI, the agent-memory research wave) is
overwhelmingly shaped by **session-based coding/web agents**, and Muse is a different
animal. We adopt their proven mechanics, but the *organizing principle* is ours.

## Why we can't just copy the coding-agent playbook

| | Session-based coding agent (Claude Code, Cursor, web agents) | **Muse — continuous personal companion** |
|---|---|---|
| Unit of context | one **task** (a bug, a feature, a browse) | one **person, across months** |
| Corpus | a codebase + live tool outputs (file reads, test logs, diffs) | the user's life: notes, past sessions, contacts, calendar, habits |
| Dominant pressure | huge tool outputs overflow one window mid-task | the *right few* personal facts must surface, session after session |
| Lifetime | context dies at task end | context is **cross-session by default** |
| Failure that hurts | task stalls / loops / forgets the file it wrote | a **confident wrong memory** about the user's life |
| Truth model | code either compiles or not — the repo is ground truth | grounding is the only truth signal; **fabrication = 0 is the release gate** |
| Model | frontier cloud model, large window | **local gemma4:12b, small window** — discipline is existential, not an optimization |

The coding-agent literature optimizes *task completion under window pressure*. Muse
optimizes *faithful personal recall under a small local window, forever*. Same toolbox,
different objective function.

## The five principles (Muse-specific)

1. **The unit of selection is the person, not the task.** What enters context is chosen
   by personal relevance × recency × **grounding confidence** — not "what files does
   this touch." Selection is the first context lever, and it is relevance-gated at every
   surface (recall, proactivity, reflection, vision).

2. **Grounding-first assembly — citability is an admission criterion.** A block earns a
   place in the prompt only if a real source backs it. Weak grounding becomes "I'm not
   sure"; an un-groundable claim is dropped by code. This is the inversion of the coding
   agent, which will happily stuff a plausible-but-unverified file in. Muse's context is
   *evidence*, and the deterministic grounding + citation gate sits under every surface.

3. **Cross-session continuity is the spine, not a feature.** The episodic→semantic
   **consolidation loop** (past sessions → durable facts, surfaced as the recap /
   `/memory`, with durable-vs-provisional and value-volatility signals) is what turns
   Muse from a stateless responder into something that *knows you*. "Session" is a
   continuous companion thread, not a task scope. Forgetting and conflict-resolution
   (correction-decay) are first-class — a companion that remembers *wrong* is worse than
   one that forgets.

4. **Lean-by-construction because the model is small and local.** Every byte competes for
   a tiny window that degrades after 2–3 reasoning steps ("context rot" bites a 12B far
   harder than a frontier model). So the budget ceilings, observation masking, tool-set
   ceiling, and query-anchored capping are *existential*, not nice-to-haves — and each
   must keep the load-bearing source while shedding the rest. Lean **without** dropping a
   needed source is the whole game.

5. **Recalled context is an untrusted, sensitive surface.** The user's memory is their
   most private data AND the substrate the grounding edge runs on — so it is also the
   highest-value poisoning target (OWASP ASI06, "Memory & Context Poisoning", 2026
   Agentic Top 10). Muse treats recalled memory as potentially-tampered: provisional-fact
   marking, injection neutralization before assembly, and source-integrity checks are part
   of context assembly, not a separate security bolt-on.

## How the public mechanics map onto the doctrine

The field's converged toolbox (Anthropic's compaction/structured-note-taking/minimal-tools;
OpenAI's write/select/compress/isolate; the working/episodic/semantic/procedural memory
stack) — Muse uses all of it, but bent to the five principles above:

- **Select** → relevance-gated tool exposure + grounding-source selection (principle 1/2).
- **Compress** → observation masking (re-fetchable), query-anchored cap, conversation
  trimming, per-source budget ceilings (principle 4) — always content-preserving so
  grounding survives.
- **Write/persist** → the episodic store + durable-fact promotion (principle 3).
- **Isolate** → sub-agent/orchestration context isolation (a Muse axis of its own).
- **Position** → "lost in the middle" / attention-basin edge-placement, now query-aware
  (principle 1+4).

What the coding-agent playbook does NOT give us, and we must invent: the **grounding
admission gate** (principle 2), the **cross-session consolidation spine** (principle 3),
and the **memory-as-untrusted-surface** posture (principle 5). Those are Muse's own.

## What "top-tier" means here (the bar the loop holds)

Not "biggest window" or "best on a coding benchmark" — by construction we lose those on a
fixed 12B. Top-tier for Muse = **the highest faithful-recall-per-token under a small local
window, proven continuously**: every context change ships a deterministic test that the
context got leaner OR more relevant *without dropping a needed source* (fabrication = 0
holds), and the grounded-surface count never drops. That invariant, enforced every fire,
is the moat — not any single mechanism.

## Sources (public, verified — adopt the method, cite the source)

- Anthropic — [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) (2025-09-29): context rot, compaction, structured note-taking, minimal tools, prune history.
- OpenAI — [Agents SDK: short-term memory / Sessions (trimming + compression)](https://cookbook.openai.com/examples/agents_sdk/session_memory); the write/select/compress/isolate framing.
- Agent-memory architecture (working/episodic/semantic/procedural; episodic→semantic consolidation; intelligent forgetting; conflict resolution) — [Practical guide to memory for autonomous LLM agents](https://towardsdatascience.com/a-practical-guide-to-memory-for-autonomous-llm-agents/), [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026).
- Long-term / personalized memory research — Hierarchical Memory Orchestration for Personalized Persistent Agents (arXiv:2604.01670); reflective memory management for long-term personalized dialogue (2025); Mem0 / LoCoMo (ECAI 2025); Zep temporal knowledge graph (2025).
- Security — OWASP Agentic AI Top 10 (2026) **ASI06 Memory & Context Poisoning**; A Survey on the Security of Long-Term Memory in LLM Agents (arXiv:2604.16548).
- Positional — Lost in the Middle (arXiv:2307.03172), Attention Basin (arXiv:2508.05128); budget — AdaGReS (arXiv:2512.25052), ContextBudget (arXiv:2604.01664); history compaction — The Complexity Trap (arXiv:2508.21433), ACON (arXiv:2510.00615).

Loop journal: [`docs/goals/loops/context-strategy.md`](../goals/loops/context-strategy.md).
