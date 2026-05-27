# 760 — feat: knowledge_search reachable in the real assembly (P20 knowledge wiring)

## Why

754/755 built + proved the multi-doc RAG-with-citation engine and
`createKnowledgeSearchTool`, but they were referenced ONLY by their
own tests — never wired into a real runtime surface. So a user
running `muse ask --with-tools` could NOT actually ground an answer in
their notes. The P20 audit (759) flagged this as the production-wiring
follow-on. This slice makes the capability reachable.

## Slice

- `createNotesKnowledgeSearchTool({ notesProvider, embed, … })`
  (`@muse/autoconfigure`) — a read-only `knowledge_search` tool that
  re-assembles the corpus from the LIVE notes store on each call (a
  note added since the last query is searchable), then ranks + renders
  with `[source]` labels. Reuses `assembleKnowledgeCorpus` +
  `rankKnowledgeChunks` + `renderKnowledgeMatches`.
- Wired into `createMuseRuntimeAssembly`: a gated tool supplier builds
  it from `notesRegistry.primary()` + `createOllamaEmbedder` (now
  exported) when `MUSE_KNOWLEDGE_SEARCH_ENABLED=true`. Off by default —
  it embeds the corpus per query (local Ollama), so it stays opt-in
  like episodic embedding.

## Verify

- `@muse/autoconfigure` knowledge-search-wiring.test.ts (new, 4):
  - the tool executes over a REAL `LocalDirNotesProvider` (temp dir,
    real `.md`) + a deterministic fake embed → returns the matching
    passage WITH `[notes/health.md]`; picks up a note added AFTER the
    tool was built (fresh-per-call).
  - `createMuseRuntimeAssembly` exposes `knowledge_search` in the tool
    registry when `MUSE_KNOWLEDGE_SEARCH_ENABLED=true`, and does NOT by
    default (opt-in reachability gating).
- **Mutation-proven**: forcing the tool's `query` to `""` (drop the
  arg plumbing) makes both execute tests fail (no matches); restore →
  4/4.
- Full `pnpm check` EXIT 0 (autoconfigure 177, every workspace green);
  `pnpm lint` 0/0. The tool's embed is local Ollama at runtime; the
  test drives the real assemble→rank→render path with a fake embed
  (no LLM request/response path changed → no `smoke:live`).

## Decisions

- **Lazy per-call corpus** (not cached at assembly time) — fresh notes
  every query, and `createMuseRuntimeAssembly` stays synchronous (it
  can't await an eager assemble). Personal scale (<100 notes) makes
  per-query embedding acceptable; precomputed chunk embeddings are a
  later optimisation.
- **Opt-in (`MUSE_KNOWLEDGE_SEARCH_ENABLED`, default off)** — mirrors
  the episodic-embedding opt-in; the feature needs a local embedding
  model pulled, so it shouldn't fire for users who haven't enabled it.
- No bullet flip — P20 knowledge is already `[x]` (754/755); this is
  the production wiring the audit named, recorded as a new
  CAPABILITIES line (the capability is now user-reachable).
