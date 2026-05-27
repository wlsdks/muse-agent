# 703 — P14 target-completion audit (the P→P seam check)

## Why

P0–P13 are audited; P14 (document understanding / PDF grounding) is the
next oldest completed target with no `P14 audit —` line. Per the
iteration-loop PROCEDURE Step 4, the sole mandate is to re-run every
P14 `CAPABILITIES.md` check TOGETHER AND exercise P14 as one end-to-end
user flow against the falsifiable test ("a real document → a grounded
answer citing it; a decoy excluded").

## Verify

- **Deterministic piece-check**, re-run green: `@muse/cli`
  commands-notes-rag.test.ts 16/16 — `extractDocumentText` (pdf-parse
  extraction; asserts it is parsed text, not raw PDF bytes) +
  `reindexNotes` PDF ingest (the PDF's extracted text is chunked +
  the PDF chunk ranks above a decoy markdown via a deterministic
  embedder).
- **End-to-end live flow (falsifiable test)**, re-run green:
  `pnpm smoke:live` "muse ask grounds an answer in a real PDF and
  excludes a decoy (P14)" PASS — a real PDF reindexed via the real
  local `nomic-embed-text`, then `muse ask` via real qwen3:8b answers
  grounded in the PDF's figure with the PDF chunk top-ranked and the
  decoy excluded.
- `pnpm check:capabilities` ✓; lint clean (no source change).

## Status

**PASS.** P14's extract → reindex → retrieve(decoy-excluded) →
grounded-answer chain composes both deterministically (the retrieval
ranking, fake embedder) and live (the real embed + real qwen
round-trip). No drift; no bullet reopened. A `P14 audit — … — PASS`
line is appended to the `docs/goals/README.md` Rejected ledger.

## Decisions

- **No new seam test** — the deterministic retrieval check
  (commands-notes-rag) and the live grounded-answer check (smoke:live)
  already compose the whole chain end-to-end across the two layers
  (offline ranking + live LLM grounding); a redundant test would be
  inward churn.
- **Live check runs because the embed model is local** — goal 693
  pulled `nomic-embed-text`, so the notes-RAG live path (and this
  audit's end-to-end) runs rather than skipping.
- **Audit is steering upkeep** — `docs(loop)`, not a counted iteration;
  no source change.

## Remaining

- **P15–P16 audits pending** — one per iteration, oldest first (P15
  next). After all are audited, extend OUTWARD-TARGETS toward the
  north star.
