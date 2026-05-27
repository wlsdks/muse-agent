# Goal 921 — `muse show` rejects a non-image file (parity with `muse vision`)

## Outward change

`muse show <path>` now rejects a non-image file — `notes.txt doesn't
look like an image (PNG/JPEG/GIF/WebP/BMP/HEIC) — muse show renders
images, not text/PDF/other files.` — before it emits an inline-image
escape sequence. Before, the inline path base64-encoded ANY non-empty
bytes into the iTerm2 OSC-1337 sequence, so `muse show notes.txt` (or a
typo'd path landing on a text/PDF) painted a broken-image glyph on
iTerm2/WezTerm, or handed the file to the OS image viewer on the
fallback path. Now it fails cleanly up front for both paths.

## Why this, now

Cross-surface parity with `muse vision` (915), which guards exactly
this case for its local-path branch. The two are siblings — both take
a local image path and feed its bytes downstream — and `show` already
had a 0-byte guard but not a content guard. A non-image input produced
a confusing broken render instead of a clear error. Reusing vision's
`looksLikeImage` keeps the two commands' notion of "is this an image"
identical.

## How

Imported `looksLikeImage` from `commands-vision` and added the check
right after the existing 0-byte guard in the `show` action: a buffer
whose magic bytes aren't a known image format (PNG/JPEG/GIF/BMP/WebP/
HEIC) gets a clear stderr error + exit 1, before either the inline-
sequence path or the OS-viewer fallback. Zero new dependency (the magic
sniff already lives in vision). The happy path (a real image) is
unchanged.

## Verification

`apps/cli` `program.test.ts` (`npx vitest run --root apps/cli
test/program.test.ts -t "muse show rejects"`, 2 passing — the existing
0-byte test + the new one): a `.png`-named file holding text bytes,
run through the real `muse show` action with `TERM_PROGRAM=iTerm.app`
(so the inline path would otherwise fire), asserts the "doesn't look
like an image" error, exit 1, and that NO `\x1b]1337;File=inline=1`
sequence was emitted. Mutation-proven: removing the `looksLikeImage`
guard fails the new test (broken sequence emitted); restored green.
`pnpm lint` 0/0; apps/cli alone green bar the known voice-playback
`/tmp` mkdtemp flake (passes 12/12 in isolation); apps/api 323.
Deterministic magic-byte guard, no LLM path → no smoke:live (Ollama
down regardless).

## Decisions

- Rejected up front (before both the inline and OS-viewer branches)
  rather than only guarding the inline path — `muse show` means
  "render an image"; a non-image shouldn't reach either renderer, and
  one guard placement keeps the two paths consistent.
- Reused vision's `looksLikeImage` rather than a second magic table —
  the two image-loading commands must agree on what counts as an image.
