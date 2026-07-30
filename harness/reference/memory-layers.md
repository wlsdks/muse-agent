---
title: Memory Layers
audience: [developers, AI agents]
purpose: What the agent remembers where, and when it writes and prunes — the layered memory structure
status: draft
updated: 2026-06-13
sources_basis: [Muse UserMemoryStore/ConversationSummaryStore/EpisodicRecallProvider/selectPromotableMemories/UserModelSlot, Muse SYSTEM-MAP #5, 2026 layered-memory refs]
related: [context-compaction.md, ../core/handoff-template.md, ../core/team-roles.md, architecture.md, ../README.md]
---

# Memory Layers

> **Why this slot?** A slot that was empty in the [architecture](architecture.md) self-assessment
> (now ✅). If "what the agent remembers where" is not organized into layers, context bloats or
> the thing you actually need cannot be recalled. Muse already has facts, session summaries,
> recall, promotion, and a structured model (below), so this codifies that structure as **layered
> memory**. Prose only (no code).

## 0. The one-line principle

**Keep a small core always on; load the rest on demand.** A small core always at hand + an
archival layer pulled in by relevance when needed — record at write time, retrieve by relevance
at read time, and consolidate duplicates so nothing bloats.

## 1. Layers

- **Working memory** — the live context window of the current task. Subject to limits and
  compaction ([context-compaction](context-compaction.md) · [loop-budget](loop-budget.md)).
- **Short-term** — recent conversation, the session scratchpad. The handoff form's status log
  belongs here ([handoff-template](../core/handoff-template.md)).
- **Long-term** — **facts and preferences** that cross sessions. Muse preserves these in a fact
  store and reflects them in answers.
- **Structured user model** — separate from scattered facts: preferences, taboos, and goals as
  **typed slots carrying confidence and update time** (fading and re-confirmed). Carries "this is
  who this person is" into the persona.
- **Episodic** — **compressed summaries** of past sessions, recalled by relevance when a similar
  topic comes up.

## 2. When to do what (write · read · prune)

- **Write-time** — automatically extract and store durable facts/preferences surfaced in
  conversation.
- **Read-time** — retrieve by relevance when needed (query matching + a unified corpus).
- **Consolidate** — merge near-identical summaries to prevent bloat (duplicate-memory cleanup).
- **Promote** — raise frequently/recently recalled memories into the **always-on core**
  (dreaming, based on proven usefulness).
- **Decay** — inferred preferences fade by confidence half-life and gradually drop out;
  accumulate and re-confirm.

## 3. Keeping it from bloating (how layers relate to compaction)

- Working/short-term memory is reduced via [context-compaction](context-compaction.md)
  (importance weighting + summarization).
- Long-term/episodic memory is managed by **consolidation, promotion, and decay** — keep the
  always-on core small and page in the rest.

## 4. One-line summary (memory checklist)

1. Are the layers — working, short-term, long-term, structured model, episodic —
   **distinguished**?
2. Does it **extract at write time / retrieve by relevance at read time**?
3. Does it prevent bloat with **consolidation, promotion, decay**?
4. Is the always-on **core small**, with the rest loaded on demand?
5. Do working/short-term mesh with **compaction** to stay within limits?

## 5. Measured (write rules verified with real Claude Code, 2026-05-31)

Memory's core risk is **storing everything long-term until it bloats, or hardening weak
inferences into facts**. We gave the curator role the §2 write rules, had it classify three
candidates, and checked that the rules actually work in a real agent.

- **Three input candidates:** ① "I always use dark mode" (explicit, repeated preference)
  ② "kimbap for lunch today" (one-off detail) ③ (inference) "seems to prefer short answers"
  (weak single signal).
- **Result (identical over 2 repeats):** `long-term store=①` · `drop=②` · `hold at low
  confidence=③`. Only the durable preference goes long-term, the one-off is discarded, and the
  **weak inference is held, not hardened into fact** (0 speculative stores). pass^2.

> Meaning: evidence that the memory layers separate **what to keep and what to discard at write
> time** by rule, not just on paper. Bloat prevention (one-off dropped) and speculation
> prevention (weak signal held) confirmed by measurement.
> [harness-acceptance §7.5](harness-acceptance.md).

---

## Runtime component (code)

The layers/behaviors above implemented as deterministic code:
[runner/memory.mjs](../runner/memory.mjs) (zero dependencies). **The model judges what to
remember**, and **the code performs store/retrieve/consolidate/decay/promote deterministically**.

- `write({text, kind, durable, confidence, source})` — write. **`durable:false` (one-off) is
  never stored long-term**; empty text is rejected (bloat/garbage prevention).
- `read(query, {limit})` — token-overlap relevance retrieval (recency/confidence tiebreak),
  increments recall count.
- `consolidate()` — merges duplicates with identical normalized text (keeps highest confidence,
  sums recalls).
- `decay({at})` — only **inference** entries decay by confidence half-life; dropped below the
  floor. Explicit facts/preferences are immutable.
- `promote({minRecalls})` — promotes frequently recalled entries into the **always-on core**.
  Query via `core()`.

Verification: [runner/memory.test.mjs](../runner/memory.test.mjs) —
`node --test "harness/runner/*.test.mjs"`: write (one-off dropped, empty rejected) · relevance
read + recall · duplicate merge · inference decay (half-life, floor drop, facts immutable) ·
promotion. **5/5** (runner suite cumulative **50/50**).

## Sources (verified basis)

- Muse product — SYSTEM-MAP #5 (automatic fact learning · structured user model · past-session recall · duplicate cleanup · dreaming promotion · confidence decay)
- Muse runtime — fact store / session-summary store / episodic recall / usefulness-based promotion / typed-slot user model (code-verified)
- 2026 — layered memory (working/short/long/episodic) + hierarchical core/archival/recall, write-time extraction · read-time retrieval · consolidation
