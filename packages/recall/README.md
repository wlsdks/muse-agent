# @muse/recall

The grounded-recall and `muse ask` pipeline: retrieval over notes/browsing/episodes/feeds,
the per-surface grounding wedges (session, activity, personal-store, flows), and citation
rendering. It exists as its own package because this retrieval-to-cited-answer pipeline was
extracted out of the CLI's `commands-ask.ts` to keep the CLI a thin command layer.

## Public surface

- `runGroundedRecall`-family pipeline in `pipeline.js` — the end-to-end retrieval → grounding
  → citation flow driving `muse ask`.
- `ask-session-grounding.js`, `ask-note-retrieval.js`, `ask-activity-grounding.js`,
  `ask-personal-store-grounding.js`, `ask-flows-grounding.js` — the per-surface grounding
  wedges, each selecting evidence and building its own prompt block.
- `citation-stream.js` — live-stream citation gating (`createCitationStreamFilter`).
- `chat-answer-gate.js` — the deterministic answer-quality gate for chat surfaces.
- `notes-index.js`, `notes-chunk.js`, `notes-links.js`, `embed.js`, `document-reader.js` —
  note indexing, chunking, embedding, and document (PDF/XML) parsing.
- `browsing-store.js`, `chrome-history.js`, `browsing-sync.js` — browser-history ingestion.
- `episode-index.js`, `feeds-store.js`, `temporal-claim-graph.js` — episodic and feed indexing.
- `user-persona.js`, `user-model-layer.js` — persona/user-model composition for prompts.
- `history-search.js`, `history-search-tool.js` — the `history_search` tool implementation.
- Re-exports `MEMORY_INJECTION_PATTERNS`, `escapeSystemPromptMarkers`, `classifyPreferenceSlots`
  from `@muse/agent-core` so callers don't need a second import.

## Depends on

- `@muse/agent-core` — the grounding/injection primitives this pipeline wires together.
- `@muse/memory` — conversation and user-memory persistence consumed by the grounding wedges.
- `@muse/model` — model calls for embedding and answer synthesis.
- `@muse/stores` — the personal stores (notes, browsing, episodes) this package indexes.
- `@muse/tools`, `@muse/mcp-shared` — tool contracts and shared retry/relative-time helpers.
- `@muse/calendar`, `@muse/scheduler`, `@muse/prompts`, `@muse/shared` — calendar grounding,
  scheduling, prompt composition, and shared types.

## Rules that bind this package

- [`../../CLAUDE.md`](../../CLAUDE.md) — grounded personal-data paths here must cite their sources, lower weak
  matches, and drop invalid citations; the per-surface grounding ratchets must stay intact.
- [`../../.claude/rules/verification/agent-testing.md`](../../.claude/rules/verification/agent-testing.md) — grounding correctness here is evaluated (`pass^k`,
  citation precision/recall floors), not proven by a passing unit test alone.

## Tests

```bash
pnpm --filter @muse/recall test
```
