# Goal 906 — `muse watch-folder` handles binary blobs instead of firing mojibake

## Outward change

Dropping a photo, PDF, or any binary file into the watched inbox now
fires a clean notice — `📎 photo: png file (48213 bytes) — binary, no
text preview` — instead of a notice full of garbled bytes, and (with
`--as-task`) no longer dumps raw binary into the task's notes or
mis-parses it for a fake `due:` line. Before, every dropped file was
read as UTF-8 unconditionally, so an image produced an unreadable
mojibake notice and a garbage-filled task — even though the module's
own header comment claimed "binary blobs are ignored."

## Why this, now

`muse watch-folder` is the credential-free ambient-perception trigger
(P20): any external producer (Mail rule, calendar handler, Hazel,
a webhook) drops a file and Muse notices. The moment a real producer
emits a non-text payload — a PDF invoice, a `.ics`, a screenshot — the
notice was unreadable. A perception surface that garbles half its
real-world inputs is a daily-driver reliability defect. The fix also
makes the code honour the behaviour its doc already promised.

## How

Extracted a pure `buildInboxNotice(filename, buffer, maxPreviewBytes)`
(the extract-pure-function-from-FS pattern) that:
- detects binary via the existing `isLikelyBinary` from
  `commands-read` (NUL-byte presence — one shared definition, no
  second copy), and
- for a binary file returns a filename + byte-count notice and an
  EMPTY body, so the downstream due-hint parse falls back to the
  default lead and the task notes stay clean;
- for text returns the first-non-empty-line preview exactly as before.

`handleFile` now delegates to it: `const { body: raw, text, title } =
buildInboxNotice(...)`. The text path is byte-for-byte unchanged. The
stale "binary blobs are ignored" header comment was corrected to
describe the actual (now-implemented) behaviour.

## Verification

`apps/cli` `commands-watch-folder.test.ts` (`npx vitest run --root
apps/cli commands-watch-folder.test.ts`, 12 passing): text file →
`binary:false` + first-line preview + populated body; PNG/NUL blob →
`binary:true` + `📎 … png file (N bytes)` + EMPTY body (the critical
no-garbage-in-notes assertion); extensionless binary → "binary file"
label; large text → body truncated to `maxPreviewBytes`. Mutation-
proven: disabling the `isLikelyBinary` branch fails the two binary
tests; restored green. `pnpm check` green (apps/cli 1606, apps/api
323); `pnpm lint` 0/0. Pure file IO, no LLM path → no smoke:live
(Ollama down regardless).

## Decisions

- Reused `commands-read`'s `isLikelyBinary` rather than re-deriving
  binary detection — the inbox watcher and the document reader should
  agree on what "binary" means, and one definition can't drift.
- A binary blob is surfaced (filename + size) rather than silently
  dropped: the user dropped it on purpose, so "you got a 48 KB PDF
  named invoice" is the useful signal — just without pretending its
  bytes are a text preview.
