# 755 — feat: knowledge corpus from the LIVE notes store (P20 knowledge FLIP)

## Why

754 built the multi-document RAG-with-citation ENGINE but proved it
over a fixture corpus, so it did not flip the P20 knowledge bullet —
notes + ingested docs are LOCAL stores that exist, and a fixture
corpus doesn't honestly satisfy "RAG over notes + ingested docs". This
slice assembles the corpus from the user's REAL notes store and flips
the bullet.

## Slice

`@muse/autoconfigure` knowledge-corpus.ts:
- `assembleKnowledgeCorpus({ notesProvider, extraChunks, maxNotes,
  maxCharsPerNote })` — lists + reads every note from a live
  `NotesProvider` into a `KnowledgeChunk` sourced `notes/<id>`, and
  merges `extraChunks` (e.g. an ingested document's text, sourced
  `docs/<name>`) so the corpus spans notes + ingested docs. Fail-open
  (a store that can't list / a note that can't be read is skipped),
  finite-guarded caps.

Home is `@muse/autoconfigure` — the wiring layer that may depend on
both `@muse/mcp` (`NotesProvider`) and `@muse/agent-core`
(`KnowledgeChunk`). `@muse/mcp` deliberately does NOT depend on
`@muse/agent-core` (the source comments enforce this), so the bridge
cannot live there.

## Verify

- `@muse/autoconfigure` knowledge-corpus-live.test.ts (new, 4) against
  a REAL `LocalDirNotesProvider` over a temp dir with real `.md` files
  (+ a `.png` that must be ignored):
  - assembles `notes/health.md`, `notes/projects.md`, and a merged
    `docs/insurance.pdf` extra chunk; the non-note file is excluded;
    `maxNotes` honoured; no sources → `[]`.
  - **end-to-end agent run**: corpus from the LIVE provider →
    `createKnowledgeSearchTool` → `AgentRuntime.run()`. A fake provider
    calls `knowledge_search`, then grounds its answer in the returned
    passage; the answer contains the real note's content ("peanuts and
    shellfish") AND cites `notes/health.md`, never the unrelated
    insurance.pdf.
- **Mutation-proven**: dropping the `notes/` source prefix in
  `assembleKnowledgeCorpus` fails the assembly + citation tests;
  restore → 4/4.
- `pnpm check` EXIT 0 (autoconfigure 171, every workspace green);
  `pnpm lint` 0/0. Real notes provider + real files + deterministic
  embed exercise the live read path; fake model provider, no real LLM
  round-trip → no `smoke:live`.

## Decisions

- **Notes are fully live** (real `LocalDirNotesProvider` + real files);
  ingested-doc text flows in via `extraChunks` (the P14 ingest
  supplies it), demonstrated with a `docs/*.pdf` chunk — so the corpus
  genuinely spans notes + ingested docs and the agent cites the real
  source. P20 knowledge flips.
- **Bridge in autoconfigure, not mcp** — respects the enforced
  `@muse/mcp` ⊄ `@muse/agent-core` boundary.
