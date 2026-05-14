# 088 — `muse read <pdf>` — document understanding via pdf-parse

## Why

JARVIS skims a brief Tony hands him. Muse can't read PDFs today —
every doc has to be manually copy-pasted into the chat. Add
`muse read <path.pdf>` that extracts the text via the `pdf-parse`
npm package (pure JS, ~40KB) and optionally pipes it through the
LLM via `--ask "<question>"`. OSS only, all local.

## Scope

- New `apps/cli/src/commands-read.ts` with `muse read <path>
  [--ask "..."] [--model <id>] [--json]`.
- Use `pdf-parse` to extract `text` + page count.
- Without `--ask`: print extracted text (or `--json` payload).
- With `--ask`: build a "system: you read documents; user: <ask>
  about THIS document text: <extracted>" turn and stream the reply
  via `assembly.modelProvider.stream`. Reuses goal 067's
  `withSigintAbort` so Ctrl-C exits cleanly.
- `--ask` requires `MUSE_MODEL` (or `--model`); else exit 2 with a
  hint.

## Verify

- cli +1 unit test on a generated fixture PDF (build one inline
  via `pdfkit` if available, else commit a 2-page fixture under
  `apps/cli/test/fixtures/`).
- Dogfood:
  ```
  # Generate a minimal one-page PDF via Node (no extra deps; just
  # write a hand-rolled PDF byte sequence — fragile but enough for
  # a smoke check).
  node -e "
  const f=require('fs');
  const pdf='%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 300 100]/Contents 5 0 R>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n5 0 obj<</Length 44>>stream\nBT /F1 12 Tf 50 50 Td (hello jarvis) Tj ET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000101 00000 n\n0000000196 00000 n\n0000000257 00000 n\ntrailer<</Size 6/Root 1 0 R>>\nstartxref\n349\n%%EOF';
  f.writeFileSync('/tmp/muse-read-test.pdf', pdf);
  "
  node apps/cli/dist/index.js read /tmp/muse-read-test.pdf
  ```
  Pass if stdout contains `hello jarvis`.

## Status

open
