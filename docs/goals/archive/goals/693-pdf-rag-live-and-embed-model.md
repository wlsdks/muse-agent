# 693 — P14 COMPLETE: pulled the local `nomic-embed-text` model and added a `smoke:live` check proving `muse ask` answers grounded in a real PDF with the decoy document excluded — the live end-to-end that 692 left pending

## Why

Goal 692 wired PDF extraction into the notes RAG (decoy-excluded
retrieval, deterministic integration test) but kept P14 `[ ]` because
the live grounded-answer-over-a-PDF-corpus was blocked by the absence
of a local embed model on the loop PC. This iteration removes that
block and proves the full chain live, flipping P14.

## Slice

- **Environment**: `ollama pull nomic-embed-text` — the free,
  open-source (Apache-2.0) embedder the project's local RAG is built
  around; zero monetary cost, local-only. Getting it onto the loop PC
  also unblocks the notes-RAG live path generally.
- `scripts/smoke-live-llm.mjs`:
  - New `ollamaHasModel(needle)` helper.
  - New live check **"muse ask grounds an answer in a real PDF and
    excludes a decoy (P14)"**: writes a temp notes dir with a minimal
    hand-built PDF (a distinctive budget figure) + an unrelated decoy
    markdown, runs the built CLI `muse notes reindex` (real
    `nomic-embed-text`) then `muse ask … --json` (real qwen3:8b), and
    asserts the PDF chunk is the top grounded hit carrying the
    extracted figure, the decoy ranks below it, and the model's answer
    is grounded in the PDF's number. Skips (via the goal-689 `skip`
    mechanism) when the CLI isn't built or `nomic-embed-text` is
    absent.

## Verify

- `pnpm smoke:live` (`OLLAMA_BASE_URL=http://127.0.0.1:11434
  MUSE_SMOKE_LIVE_MODEL=qwen3:8b GEMINI_API_KEY=""`):
  **14 passed, 0 failed, 1 skipped** — including **PASS "muse ask
  grounds an answer in a real PDF and excludes a decoy (P14)"**.
- Live evidence (the dog-food this check automates): the PDF
  `budget.pdf` retrieved at cosine **0.843**, the decoy at **0.384**,
  and qwen3:8b answered "The Q3 marketing budget is 47,000 dollars,
  allocated to events" — grounded in the PDF.
- `pnpm lint`: 0/0. Byte-scan on the smoke script: clean. (No package
  source changed — only the smoke harness + docs — so `pnpm check` is
  unaffected; 692's `commands-notes-rag` code is the path under test.)

## Status

**P14 FLIPPED.** The agent ingests a real PDF, answers grounded in it
citing the content, and a decoy document is excluded — proven by a
repeatable `smoke:live` check (693) on top of the deterministic
retrieval integration test (692) and single-doc `muse read` (088).

## Decisions

- **Pulled the embed model as environment-readiness work** — the
  iteration-loop contract treats getting the local model environment
  up as priority outward work; `nomic-embed-text` is the embedder the
  RAG requires, free and local, so pulling it is in-scope and unblocks
  both P14 and the notes-RAG live path.
- **Live check lives in `smoke:live`, spawning the built CLI** — the
  notes RAG is CLI-side (not an HTTP endpoint), and `smoke:live`
  already runs in a real-qwen context; the check spawns
  `apps/cli/dist/index.js` with a temp `HOME`/`MUSE_NOTES_DIR` so it
  never touches the user's real `~/.muse`.
- **Skips, not fails, when prerequisites are absent** — no built CLI or
  no `nomic-embed-text` ⇒ `SKIP` (same honest-signal stance as the
  web_search and tiered checks), so the suite stays exit-0 on a host
  without the embed model.
- **Assert the figure, not an exact answer** — qwen's phrasing varies,
  so the check asserts the PDF's number (`47000`) appears in the
  answer and that the PDF chunk out-ranks the decoy — robust to LLM
  nondeterminism.

## Remaining risks

- **Citation-filename accuracy** — in the dog-food the model grounded
  the CONTENT correctly but cited a hallucinated filename; the check
  asserts grounding (the figure + top-ranked PDF), not the literal
  cited path. Tightening the model's source-citation accuracy is a
  general `muse ask` concern, not P14-specific.
- **`.docx` / office still unsupported** — only PDF; docx needs a zip
  reader behind `extractDocumentText` (future additive slice).
- **Scanned/image PDFs** yield no text (pdf-parse extracts embedded
  text only; OCR out of scope).
