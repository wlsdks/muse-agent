# 769 — feat: cache knowledge embeddings — corpus embedded once, not per query (P20 knowledge)

## Why

`rankKnowledgeChunks` embeds the query AND every corpus chunk on every
`knowledge_search` call. With the unified corpus (notes + tasks +
calendar + contacts) that is ~100+ Ollama embed calls PER query, and
the corpus barely changes between queries — so the same chunks are
re-embedded every time. That is the daily-driver responsiveness cost
(seconds per query) and wasted local compute.

## Slice

`@muse/agent-core` `createCachingEmbedder(embed, { maxEntries })` —
memoizes `text → vector`:
- caches the PROMISE so concurrent calls for the same text dedupe into
  one embed,
- evicts a rejected embed (a transient Ollama failure is never cached
  forever — the next call retries),
- bounded FIFO (default 4096 entries).

Wired in the assembly: the `knowledge_search` tool's embedder is
`createCachingEmbedder(createOllamaEmbedder(model))`, built once, so a
stable corpus is embedded once and repeat queries embed only the query
+ any new chunk.

## Verify

- `@muse/agent-core` caching-embedder.test.ts (new, 4): each distinct
  text embedded once (repeat → cache hit); 3 concurrent calls for one
  text → ONE embed; FIFO eviction beyond `maxEntries`; a failed embed
  is NOT cached (a later call retries).
- **Mutation-proven**: removing the cache-hit short-circuit makes
  every call recompute → the embed-once + dedupe tests fail; restore →
  4/4.
- Full `pnpm check` EXIT 0 (agent-core 690, every workspace green);
  `pnpm lint` 0/0. Pure memoization over an injected embed (a `vi.fn`
  spy in tests) — no model request/response path → no `smoke:live`.

## Decisions

- **Cache the Promise + evict on rejection** — dedupes in-flight
  duplicates AND keeps a transient embed failure from poisoning the
  cache. The episodic-recall embedder is fail-open already; this keeps
  the same posture.
- **Process-lifetime in-memory cache, bounded FIFO** — zero dep, zero
  cost; a long-running server keeps the corpus warm, and the bound
  prevents unbounded growth. No bullet flip — P20 knowledge is already
  `[x]`; this is a responsiveness deepening (CAPABILITIES line).
