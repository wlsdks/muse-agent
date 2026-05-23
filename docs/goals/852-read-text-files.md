## 852 — feat: `muse read` handles text files, not just PDFs

## Why

`muse read` was PDF-only (always `parsePdfBuffer`), so a `.txt` / `.md`
/ `.log` / `.csv` / transcript couldn't be read, `--ask`-ed, or
ingested (846 `--save-to-notes`) — yet plain-text docs are the most
common thing to ask about / remember. P14 explicitly targets document
understanding "beyond PDF". A binary file (`muse read photo.png`) also
silently dumped garbage.

## Slice — multi-format extraction

`apps/cli` commands-read.ts:
- `isPdfDocument(filePath, buffer)` — `.pdf` extension OR `%PDF-` magic
  header.
- `isLikelyBinary(buffer)` — a NUL byte in the first 8KB.
- `extractDocumentText(filePath, buffer)` — PDF → `parsePdfBuffer`;
  binary non-PDF → a clear error ("looks binary — handles PDFs and text
  files"); else UTF-8 text (one "page"). The `read` action uses it, so
  print / `--ask` / `--save-to-notes` all work for text files too.
  Command description + arg now say "PDF or text file".

## Verify

`apps/cli` commands-read.test.ts (+5, 9 total):
- `extractDocumentText` reads a `.txt` as UTF-8 (one page), and `.md` /
  `.log` text; rejects a binary (NUL-byte) file with "looks binary";
- `isPdfDocument` detects by extension AND by `%PDF-` magic (and false
  for `.txt`); `isLikelyBinary` flags a NUL byte, passes clean text.
- The existing 4 (`buildDocumentNoteBody` / `saveDocumentToNotes`)
  stay green — text files now flow into 846's ingest too.
- **Mutation-proven**: removing the binary guard makes the
  reject-binary test fail; forcing `isPdfDocument` always-true routes
  text files into pdf-parse and fails the text-read tests. `apps/cli`
  133/133, `pnpm check` EXIT 0 (0 non-voice failures), `pnpm lint`
  0/0. FS read + display, no LLM request/response path → no smoke:live.

## Decisions

- **Reject binary, don't dump it** — `muse read photo.png` reading a
  JPEG as UTF-8 would spew mojibake; a NUL-byte heuristic catches the
  common binaries (images/zip/etc.) and reports clearly. PDFs are still
  detected by extension OR magic (so a mis-named `.bin` PDF still
  parses).
- **No new dependency** — text is read directly; `.docx` (which needs a
  parser dep) is deliberately out of scope here. Composes 846: any text
  file is now `--save-to-notes`-ingestible into the searchable corpus.
  CAPABILITIES line under P14 document understanding.
