# 723 — fix: RAG chunking hard-wraps oversized paragraphs so chunks can't overflow the embedder

## Why

`chunkText` (behind `muse notes reindex`) splits notes on blank lines
and packs paragraphs up to `chunkChars` (default 600, user-bounded
[120, 8000]). But a SINGLE paragraph longer than `chunkChars` — a wall
of prose with no blank lines, a fenced code block, a pasted minified /
base64 blob — passed through as one chunk of arbitrary length. That
chunk can exceed `nomic-embed-text`'s context window and get silently
truncated, so its embedding represents only the start and retrieval
recall drops for everything past the cutoff. The whole point of chunking
(bounded, coherent embedding targets) was defeated for exactly the
densest notes.

Rotated surface (PROCEDURE Step 8: recent iterations churned
messaging/channel, cli-actions, vision, model, proactive, calendar —
this is the notes/RAG surface).

## Slice

- `apps/cli/src/commands-notes-rag.ts`: `chunkText` now hard-wraps each
  paragraph through a new `hardWrap(para, max)` before packing.
  `hardWrap` breaks at the last whitespace in the `max`-char window (so
  words aren't cut mid-token), falling back to a hard cut at `max` for an
  unbreakable run; paragraphs already within `max` pass through. Net:
  every emitted chunk is `<= chunkChars`. `chunkText` is now exported for
  direct test coverage.

## Verify

- `@muse/cli` commands-notes-rag.test.ts (1267 tests): small paragraphs
  pack within the bound; an oversized paragraph splits at word
  boundaries with every chunk ≤ chunkChars and no content lost; an
  unbreakable 500-char run hard-cuts into `ceil(500/80)` pieces each
  ≤ 80; empty / whitespace-only → `[]`.
- **Mutation-proven**: dropping the `hardWrap` call (paragraphs passed
  through untrimmed for size) fails the oversized + unbreakable tests.
  Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
- No LLM request/response path touched — `chunkText` is pure string
  logic; the embedding call is unchanged, it just receives bounded
  chunks now.

## Decisions

- **Prefer a whitespace break, hard-cut only when forced** — splitting
  mid-word hurts the embedding's semantic coherence, so break at the last
  space/newline/tab in the window; only cut hard (at `max`) when the run
  has no whitespace in the back ~40% of the window (a URL/blob), which is
  unavoidable and still bounded.
- **Keep the existing pack-by-paragraph behaviour for in-range notes** —
  the change is purely additive to the oversized case; ordinary notes
  chunk exactly as before (a regression test pins the small-paragraph
  packing).
