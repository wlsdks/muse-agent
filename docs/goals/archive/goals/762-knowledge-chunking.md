# 762 — feat: chunk long notes / ingested docs for passage-level RAG (P20 knowledge)

## Why

`assembleKnowledgeCorpus` TRUNCATED each note to `maxCharsPerNote`
(4000) and emitted one chunk per note. A long note or an ingested
document's text past the first 4000 chars was simply INVISIBLE to RAG
— it could neither be retrieved nor cited. For the "ingested docs"
half of P20 knowledge (a PDF's text is often large) this is a real
gap, not polish.

## Slice

- `chunkText(text, maxChars)` (`@muse/agent-core`) — splits text into
  passages of at most `maxChars`, preferring paragraph boundaries
  (blank lines) so a chunk stays coherent; packs small adjacent
  paragraphs together; hard-splits a single oversized paragraph; `[]`
  for empty, one chunk for a short text. Finite-guarded limit.
- `assembleKnowledgeCorpus` now chunks each note body instead of
  truncating: a short note stays one chunk sourced `notes/<id>`; a
  long note emits `notes/<id>#1`, `notes/<id>#2`, … so the relevant
  passage is retrievable + citable.

## Verify

- `@muse/agent-core` knowledge-chunking.test.ts (new, 4): empty → [];
  short → one chunk; three 50-char paragraphs @ maxChars 60 → 3 chunks
  each ≤ 60; a 250-char paragraph @ 100 → [100,100,50]; small adjacent
  paragraphs pack into one chunk.
- `@muse/autoconfigure` knowledge-chunking-live.test.ts (new, 2)
  against a REAL `LocalDirNotesProvider`: a note whose allergy fact is
  in the SECOND paragraph (past `maxCharsPerNote: 60`) → corpus emits
  `notes/long.md#1` + `notes/long.md#2` and the fact is preserved in
  `#2` (the old truncate dropped it); end-to-end `knowledge_search`
  answers from `#2` and cites `notes/long.md#2`, not the filler.
- Existing knowledge tests still 9/9 (short notes stay `notes/<id>` —
  backward compatible).
- **Mutation-proven**: dropping `chunkText`'s final-flush loses the
  last chunk → the paragraph-split test fails; restore → 4/4.
- Full `pnpm check` EXIT 0 (agent-core 686, autoconfigure 179, every
  workspace green); `pnpm lint` 0/0. Pure text + corpus assembly with
  a deterministic fake embed — no model request/response path → no
  `smoke:live`.

## Decisions

- **Paragraph-preferring, hard-split fallback** — keeps a retrieved
  passage coherent (whole paragraphs) while bounding pathological
  single-paragraph blobs. Personal scale, so per-query embedding of a
  few extra chunks is acceptable; precomputed chunk embeddings are a
  later optimisation.
- **Backward-compatible source labels** — a single-chunk note keeps
  `notes/<id>`; only multi-chunk notes get the `#n` suffix, so prior
  citations / tests are unchanged. No bullet flip — P20 knowledge is
  already `[x]`; this deepens retrieval quality (CAPABILITIES line).
