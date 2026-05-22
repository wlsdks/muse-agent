# 692 — P14 (RAG slice): a PDF dropped in the notes dir is ingested into Muse's RAG corpus — `muse notes reindex` / `muse ask` extract `.pdf` text via `pdf-parse` (reusing `muse read`'s parser) so a question retrieves the relevant PDF chunk with a DECOY document excluded

## Why

P14 wants the agent to ground answers in real documents with a decoy
excluded. `muse read <pdf> --ask` (goal 088) already grounds a SINGLE
PDF (cites the source, refuses out-of-doc content), but it has no
multi-document retrieval — no "decoy document excluded". The notes RAG
(`muse ask` / `muse notes reindex`) does decoy-excluded retrieval, but
only over `.md`/`.txt`. This slice connects them: PDFs become a RAG
source, so a PDF in the notes corpus is retrieved (decoy excluded) by
the existing `muse ask` pipeline. No new dependency — `pdf-parse` is
already used by `muse read`.

## Slice

- `apps/cli/src/commands-notes-rag.ts`:
  - New exported `extractDocumentText(path)` — `.pdf` → `parsePdfBuffer`
    (the `muse read` extractor), everything else → UTF-8 read.
  - `walkMarkdown` now also matches `.pdf`.
  - `reindexNotes` uses `extractDocumentText` instead of a raw UTF-8
    read, and gained an optional `fetchImpl` threaded into `embed` so
    the ingest is testable offline with a deterministic embedder.
- `apps/cli/src/commands-notes-rag.test.ts`:
  - `extractDocumentText`: a constructed minimal PDF yields the
    extracted body and NO PDF structure (`endobj`/`%PDF`); markdown is
    read verbatim.
  - "reindexNotes ingests PDFs alongside markdown": a PDF + a decoy
    `.md` reindexed via a deterministic fake embedder — the PDF chunk
    carries the EXTRACTED text (asserted free of `endobj`, so it is
    pdf-parse output not raw bytes) and ranks above the decoy for a
    matching query (decoy excluded).

## Verify

- `pnpm --filter @muse/cli` commands-notes-rag.test.ts: 16 passed
  (3 new).
- **Clean-mutation-proven**: replacing `extractDocumentText`'s PDF
  branch with a raw UTF-8 read fails the ingest test — the chunk then
  contains `endobj` (raw PDF bytes), not the clean extracted text. The
  negative `endobj`/`%PDF` assertions are what make the test prove
  actual parsing (the minimal PDF embeds the body in a literal `(...)`
  operator, so a substring check alone would pass on raw bytes too).
  Restored; green.
- `pnpm check`: EXIT=0. `pnpm lint`: 0/0. `pnpm check:capabilities`: ✓.
  Byte-scan: clean.
- De-risked the fixture: `pdf-parse` extracts the body from the
  hand-built minimal PDF (verified by a throwaway script before
  writing the test).
- No LLM request/response path touched in this slice — extraction +
  ingest are deterministic; the fake embedder keeps the test offline.

## Status

P14 PDF-RAG ingest delivered. P14 stays `[ ]` pending the LIVE
`muse ask`-over-a-PDF-corpus grounded-citing answer end-to-end, which
needs a local `nomic-embed-text` embed model (not pulled on the loop
PC) — every component is proven (extraction, decoy-excluded retrieval,
and the existing `muse ask` grounding/citation for markdown), only the
real embed+LLM round-trip over a PDF corpus is unrun. `office`/.docx is
a future additive source type.

## Decisions

- **Reuse `pdf-parse` via `muse read`'s `parsePdfBuffer`** — no new
  dep; the same MIT pure-JS extractor already in the tree.
- **`extractDocumentText` as the single routing seam** — `.pdf` →
  parse, else UTF-8; the natural extension point for `.docx` later.
- **Thread `fetchImpl` into `reindexNotes`** — lets the ingest be
  tested with a deterministic embedder, proving decoy-excluded
  retrieval without Ollama (no `nomic-embed-text` on the loop PC).
- **Negative `endobj`/`%PDF` assertions** — the minimal test PDF
  embeds its body in a `(...)` text operator, so a substring check
  would pass even on raw bytes; asserting the ABSENCE of PDF structure
  is what proves the text was actually parsed (caught via mutation
  testing).
- **Kept P14 `[ ]`** — the bullet's "grounded answer citing it" over a
  corpus needs the live embed+LLM round-trip; honest not to flip on
  retrieval-only proof.

## Remaining risks

- **No local embed model** — the live `muse ask`-over-PDF end-to-end
  can't run here; getting `nomic-embed-text` onto the loop PC (or a
  qwen-embed variant) would let a `smoke:live` flip P14.
- **`.docx` / office not yet supported** — only PDF; docx needs a zip
  reader (a future additive change behind `extractDocumentText`).
- **Scanned/image PDFs yield no text** — `pdf-parse` extracts embedded
  text only; OCR is out of scope.
