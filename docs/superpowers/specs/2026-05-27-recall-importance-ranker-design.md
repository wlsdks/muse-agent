# Importance dimension for episodic recall — design spec

- **Date:** 2026-05-27
- **Status:** approved (brainstorming) — pending spec review
- **Direction:** research-based agent-quality upgrade (EXPANSION-PLAYBOOK priority #3)
- **Source idea:** Generative Agents (arXiv 2304.03442) — retrieve by relevance + recency + **importance**

## Problem

Generative Agents retrieve memories by a weighted sum of **relevance**
(embedding similarity), **recency** (exponential time decay), and
**importance** (an LLM-assigned 1–10 score at write time). Muse's episodic
recall already computes **relevance** (`jaccardSimilarity` / `cosineSimilarity`)
and **recency** (`computeRecencyBoost`, exp decay) — but has **no importance
dimension**. Two past sessions equally relevant and equally recent rank by
relevance alone, even when one was a pivotal decision and the other was idle
chatter. The missing third axis is importance.

## Goal

Add an **importance** dimension to episodic recall, faithful to Generative
Agents and cheap on a single-user local model:
- the session summariser assigns an importance score (1–10) at write time
  (no extra model call — it rides the existing end-of-session summarise call),
- importance is persisted alongside the conversation summary,
- the recall rankers fold a bounded importance boost into the score.

Conservative by construction: an episode with no importance (every episode
written before this change) gets a **zero** importance boost — never a penalty
— so existing recall behaviour is byte-identical until new summaries carry a
score.

## Non-goals (YAGNI)

- **No** periodic "reflection"/synthesis job (a separate Generative-Agents idea;
  out of scope for this slice — it is the larger memory-synthesis work).
- **No** change to the relevance or recency math, the `minScore` gate (still
  applied to `baseSim` only), `topK`, or per-user scoping.
- **No** re-scoring of existing stored summaries (they keep importance = unset →
  zero boost).
- **No** new model call — importance comes from the summariser's existing call.

## Architecture & data flow

```
end-of-session summarise (existing single model call)
  summariseSession() → parseSummariserOutput()
    parses the paragraph + "topics:" line  (existing)
    + parses a new "importance: N" line (1–10)        ← NEW
  → SessionSummary { summary, topics, importance? }   ← importance NEW

persist (the caller upserts a ConversationSummary)
  ConversationSummary { …, importance? }              ← NEW field
    InMemory store: kept as-is
    Kysely store:   importance column (migration 0003) ← NEW
      legacy rows (no column value) read back as undefined

recall (per agent run)
  StoreBackedEpisodicRecallProvider maps summaries → episodes
    episode { narrative, createdAtIso, userId?, importance? } ← importance NEW
  InMemory / Embedding providers score each episode:
    similarity = baseSim + recencyBoost + importanceBoost     ← importanceBoost NEW
      importanceBoost = importanceWeight * clamp(importance,1,10)/10
      importance undefined ⇒ importanceBoost = 0  (conservative)
      importanceWeight default 0.15 (== recency weight; cannot dominate baseSim)
    minScore gate still applies to baseSim ONLY
```

## Detailed changes

### 1. Summariser — `packages/agent-core/src/episodic-summariser.ts`
- `SessionSummary` gains `readonly importance?: number`.
- The system prompt gains one instruction: after the `topics:` line, emit
  `importance: N` where N is 1–10 (10 = a pivotal decision/commitment worth
  recalling for a long time; 1 = idle small talk).
- `parseSummariserOutput` extracts an `importance:` line (case-insensitive,
  reverse-scan like `topics:`), parses an integer, **clamps to 1–10**, and
  drops the line from the summary body. Missing/garbage ⇒ `importance` omitted
  (`undefined`). The summary body parsing is otherwise unchanged.

### 2. Conversation summary store — `packages/memory/src/memory-conversation-summary-store.ts`
- `ConversationSummary` / `RequiredConversationSummary` gain
  `readonly importance?: number`.
- `normalizeConversationSummary` clamps a finite importance to 1–10, else drops
  it (undefined).
- InMemory store: round-trips the field (no schema work).
- Kysely `toRow`: `importance: normalized.importance ?? null`.
- Kysely `fromRow`: `importance: typeof row.importance === "number" ? row.importance : undefined`.
- The Kysely insert `onConflict` merge set adds `importance: row.importance`.

### 3. DB schema + migration — `packages/db/src/schema.ts`, `packages/db/src/migrations.ts`
- `ConversationSummaryTable` gains
  `readonly importance: ColumnType<number | null, number | null | undefined, number | null>;`
  (nullable so legacy rows stay readable — mirrors the `user_id` precedent).
- New migration `0003_conversation_summaries_importance`:
  - up: `ALTER TABLE conversation_summaries ADD COLUMN IF NOT EXISTS importance SMALLINT;`
  - down: `ALTER TABLE IF EXISTS conversation_summaries DROP COLUMN IF EXISTS importance;`

### 4. Recall rankers — `packages/agent-core/src/episodic-recall.ts`
- The episode input type gains `readonly importance?: number`.
- A `DEFAULT_IMPORTANCE_WEIGHT = 0.15` constant + `importanceWeight?` option on
  both `InMemoryEpisodicRecallProvider` and `EmbeddingEpisodicRecallProvider`
  (guarded `Math.max(0, finiteOr(options.importanceWeight, DEFAULT_IMPORTANCE_WEIGHT))`).
- New pure helper `computeImportanceBoost(importance: number | undefined, weight: number): number`
  — returns `0` when importance is undefined/non-finite; else
  `weight * clamp(importance, 1, 10) / 10`.
- Both providers: `similarity: baseSim + recencyBoost + computeImportanceBoost(episode.importance, this.importanceWeight)`.
- `StoreBackedEpisodicRecallProvider` maps `importance: summary.importance` onto
  the episode it builds from each store summary.

## Testing & verification plan

1. `pnpm --filter @muse/agent-core test` — new deterministic unit tests:
   - `computeImportanceBoost`: undefined ⇒ 0; 10 ⇒ weight; 5 ⇒ weight*0.5;
     out-of-range 0/11 clamp to 1/10; non-finite ⇒ 0.
   - `parseSummariserOutput`: parses `importance: 8`; clamps `importance: 99`→10
     and `importance: 0`→1; missing ⇒ undefined; the importance line is not
     swallowed into the summary body.
   - Ranker integration: two episodes with **equal** narrative-relevance and
     **equal** createdAt — the higher-importance one ranks first; an episode
     with undefined importance ranks identically to the pre-change behaviour
     (boost 0).
2. `pnpm --filter @muse/memory test` — store round-trips importance (InMemory),
   clamps out-of-range, drops non-finite; legacy summary without importance →
   undefined.
3. `pnpm --filter @muse/db test` — migration 0003 applies (schema test sees the
   new column); existing migration tests stay green.
4. `pnpm lint` → 0/0.
5. **Live (supplementary):** `node apps/cli/scripts/verify-tool-selection.mjs`
   is unrelated; instead a focused live check that the summariser emits a
   parseable `importance:` on a real qwen3:8b call — exercised via the existing
   episodic-summariser path if a cheap harness exists, else asserted by an
   integration test that drives `summariseSession` against a contract-faithful
   fake model returning the `importance:` line (the ranker + parse are the
   deterministic targets; the model merely emitting the line is stochastic and
   not the unit of correctness).

## Decisions

- **Importance at write time, cached — never per-recall.** Generative Agents
  scores importance once when the memory is written; recall just reads it. This
  keeps recall cheap (no per-query model calls) on the local model.
- **Rides the existing summariser call.** No new model round-trip — one extra
  output line on the call Muse already makes at session end.
- **Conservative zero-boost default.** Undefined importance ⇒ 0 boost (not a
  penalty, not a mid-value), so the change is byte-identical for every existing
  episode and for any deployment whose summariser hasn't yet emitted a score.
- **Weight == recency (0.15).** Importance is a tie-breaker among
  relevant+recent memories, never strong enough to surface an irrelevant one
  (the `minScore` gate on `baseSim` still excludes low-relevance episodes).

## Acceptance check (the deliverable's proof)

- Green deterministic `@muse/agent-core` tests: `computeImportanceBoost`, the
  `importance:` parse, and the ranker tie-break (higher importance wins at equal
  relevance+recency; undefined ⇒ unchanged ranking).
- Green `@muse/memory` store round-trip + `@muse/db` migration 0003 tests.
- `pnpm lint` 0/0.
