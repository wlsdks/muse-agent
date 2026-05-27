## 846 — feat: `muse read <pdf> --save-to-notes` ingests a document into searchable knowledge

## Why

`muse read <pdf>` could print the extracted text or answer a one-shot
`--ask` question, but it NEVER persisted anything — so a read PDF could
not enter the searchable knowledge corpus (`knowledge_search` spans
notes, but a read document never became a note). "Read this lease and
remember it so I can ask about it later" was impossible: P14 document
understanding and P20 knowledge were disconnected.

## Slice — document → note → searchable

`apps/cli` commands-read.ts:
- `buildDocumentNoteBody(sourcePath, text, pageCount)` — a markdown note
  body: a `Document — <file>` title, a `Source: <path> (N pages)`
  header, and the extracted text run through `redactSecretsInText` (a
  note is long-lived and may sync to a third-party store).
- `saveDocumentToNotes(notesDir, id, …)` — persists it via the real
  `LocalDirNotesProvider` (overwrite by id).
- `muse read <pdf> --save-to-notes <id>` saves the extracted text as a
  note under `MUSE_NOTES_DIR`, so `knowledge_search` (which spans notes)
  finds it later. Combines with `--ask`; empty extraction → a clear
  "nothing to save" notice (no crash). Default `muse read` unchanged.

## Verify

`apps/cli` commands-read.test.ts (new, 4):
- `buildDocumentNoteBody`: titles by filename, records source + page
  count, singular "page" for 1, and SCRUBS a telegram-bot-token-shaped
  secret out of the persisted text (→ `[redacted-telegram-bot-token]`);
- `saveDocumentToNotes`: writes a note that the REAL
  `LocalDirNotesProvider` reads back (the round-trip that makes
  `knowledge_search` able to find it) over a temp notes dir.
- **Mutation-proven**: dropping the redaction leaks the secret (scrub
  test fails); removing the `provider.save` call → the note can't be
  read back (round-trip test fails). `apps/cli` 133/133, `pnpm check`
  EXIT 0 (0 non-voice failures), `pnpm lint` 0/0. FS persistence, no LLM
  request/response path → no smoke:live.

## Decisions

- **Redact before persisting** — same posture as `muse today --brief
  --save-to-notes`: a saved document is long-lived and may sync, so any
  credential the PDF quotes is scrubbed before it lands.
- **Save the extracted TEXT, not an --ask answer** — ingestion is about
  making the SOURCE searchable; `--save-to-notes` works with or without
  `--ask`. This connects P14 (document understanding) to P20 (the
  searchable corpus). CAPABILITIES line under the CLI document surface
  (no bullet flip).
