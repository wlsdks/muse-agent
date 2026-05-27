# 754 — feat: multi-document RAG with source citation (P20 knowledge, slice 1)

## Why

P20 knowledge: the agent should answer from a MULTI-document personal
corpus (notes + ingested docs) and cite which source. Episodic recall
already ranks ONE corpus (conversation summaries) but carries no
source attribution and is single-source. Nothing yet ranks across
notes + docs and tells the agent WHICH document a claim came from.

## Slice

`@muse/agent-core` knowledge-recall.ts:
- `KnowledgeChunk { source, text }` / `KnowledgeMatch { source, text,
  score }` — source-agnostic by design (caller assembles chunks from
  whatever stores it has).
- `rankKnowledgeChunks(query, chunks, { embed, topK, minScore })` —
  embedding cosine ranking across the MULTI-source corpus, keeping
  each passage's `source`; sub-threshold passages dropped so an
  irrelevant corpus can't fabricate a citation. Reuses
  `cosineSimilarity` (same scorer as episodic recall).
- `renderKnowledgeMatches(matches)` — labels each passage with its
  `[source]` and instructs the agent to cite it.
- `createKnowledgeSearchTool({ corpus, embed, topK })` — a read-only
  `knowledge_search` MuseTool the agent calls to ground an answer.

## Verify

- `@muse/agent-core` knowledge-recall-agent.test.ts (new, 5):
  - `rankKnowledgeChunks`: ranks a 3-chunk / 3-source corpus by
    similarity, keeps source order (health.md > old.md), drops the
    unrelated insurance.pdf; empty query / empty corpus → [].
  - `renderKnowledgeMatches`: labels `[source]`; empty → "No matching
    passages" (no fabricated source).
  - **end-to-end agent run**: `AgentRuntime.run()` with the
    `knowledge_search` tool over a contract-faithful 2-source corpus
    (a `notes/` chunk + a `docs/*.pdf` chunk) — a fake provider calls
    the tool, then grounds its answer in the returned passage; the
    answer contains the right document's content ("peanuts and
    shellfish") AND cites `notes/health.md`, and does NOT cite the
    unrelated insurance.pdf.
- **Mutation-proven**: flipping the rank sort to ascending fails the
  ordering + citation tests; restore → 5/5.
- Full `pnpm check` EXIT 0 (agent-core 682, every workspace green);
  `pnpm lint` 0/0. Fake provider + deterministic local embed, no real
  LLM round-trip → no `smoke:live` (the real cosine-ranking + tool +
  agent tool-loop code paths run against the fake).

## Decisions

- **Did NOT flip the P20 knowledge bullet.** The bullet says "RAG over
  notes + ingested docs" — those are LOCAL stores that already exist
  (`LocalDirNotesProvider`, the PDF ingest), not an absent third-party
  service, so a fixture corpus does not honestly satisfy "over notes +
  ingested docs" end-to-end. This slice delivers + proves the
  RAG-with-citation ENGINE (ranking, source attribution, agent
  grounding); slice 2 assembles the corpus from the live notes + doc
  stores and flips the bullet.
- **Embedding-backed, reuse `cosineSimilarity`** so knowledge ranking
  matches episodic recall; `embed` injected (local Ollama in prod,
  zero-cost; deterministic fake in tests).
- **Read-only tool, drop sub-threshold passages** — never surface an
  unrelated document just to have something to cite.
