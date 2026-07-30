# @muse/memory

Conversation and user-memory persistence plus the context-engineering primitives that keep a
long-running conversation inside its token budget: trimming, compaction, salient-fact
extraction, and typed user-model slots. It is a package because both the CLI (file-backed) and
API server (Kysely-backed) need the same trim/compaction contract over the same types.

## Public surface

- `TaskMemoryStore`, `UserMemoryStore`, `ConversationSummaryStore` — the storage interfaces,
  each with an `InMemory*`, `File*`, and `Kysely*` implementation.
- `trimConversationMessages`, `estimateConversationTokens`, `createApproximateTokenEstimator`
  — the conversation-trimming/compaction entry point (`memory-token-trim.js`).
- `verifyCompactionSummaryQuality`, `extractCompactionAnchors` — the deterministic post-
  compaction quality gate for the optional aux-LLM summary.
- `extractSalientFacts`, `renderKeyDetailsBlock` — verbatim-substring salient-fact retention.
- `composeUserModelSnapshot`, `upsertUserModelSlot`, `selectReconfirmableSlots` — typed
  user-model slots (facts/preferences/goals/vetoes) and confidence-decay reconfirmation.
- `createUserMemoryAutoExtractHook`, `dropModelAssertedValues` — the auto-extract hook that
  turns a chat turn into `UserMemoryStore` writes.
- `detectTimeOfDayPatterns`, `detectWeeklyTaskPatterns`, `selectFireablePatterns` — activity
  pattern detection and cooldown-gated firing.
- `scoreRecallHit`, `selectPromotableMemories`, `selectForgettable` — ACT-R–style recall
  activation scoring for memory promotion/forgetting.
- `classifyFactFreshness`, `recordRetraction`, `FileBeliefProvenanceStore` — belief-provenance
  tracking for stale/contested/provisional facts.

## Depends on

- `@muse/db` — the Kysely `Database` type the `Kysely*Store` implementations query against.
- `@muse/model` — `ModelMessage`/`ModelToolCall` types conversation trimming operates on.
- `@muse/shared` — shared types and utilities.

## Rules that bind this package

- [`../../.claude/rules/engineering/architecture.md`](../../.claude/rules/engineering/architecture.md) — PostgreSQL/Kysely is the server source of truth; the
  `Kysely*Store` implementations here use typed SQL access per the Database rules.
- [`../../.claude/rules/verification/testing.md`](../../.claude/rules/verification/testing.md) — factual memory evidence (exact source binding, unchanged
  bytes on a rejected/replayed receipt) is a separate test dimension from user judgment.

## Tests

```bash
pnpm --filter @muse/memory test
```
