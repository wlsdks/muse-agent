# Goal 915 — `muse vision` rejects a non-image local file instead of feeding garbage to the model

## Outward change

`muse vision <path>` now rejects a local file that isn't an image —
`'notes.txt' doesn't look like an image (PNG/JPEG/GIF/WebP/BMP/HEIC) —
muse vision needs image bytes, not a text/PDF/other file` — before it
base64-encodes the bytes and POSTs them to the Ollama vision model.
Before, the local-path branch base64-encoded ANY file blindly, so
`muse vision report.pdf` or `muse vision notes.txt` silently fed
non-image bytes to the model and got back a confident hallucination
about an "image" that was never there.

## Why this, now

A cross-branch consistency gap in the same function. `loadImageAsBase64`
already guards its two remote sources — the `data:` URL branch
validates the base64 payload, and the `http(s)` branch rejects a
`text/*`/JSON content-type — precisely so a non-image input can't be
fed to the vision model as "image bytes". The **local-path** branch
had no such guard, so the most common everyday input (a file on disk)
was the one path that could silently pass garbage. Vision is Muse's
sensory input (P20 perception); a sensor that confidently describes a
text file as a photo is a real fidelity defect.

## How

New pure `looksLikeImage(buffer)` recognises common image magic bytes —
PNG, JPEG, GIF, BMP, WebP (`RIFF…WEBP`), and the ISO-BMFF `ftyp` family
(HEIC/AVIF). The local-path branch throws a clear error when the read
bytes don't match, mirroring the data-URL / URL guards' philosophy.
Zero-dep (magic-byte sniff, no image library). The remote branches keep
their existing guards unchanged.

## Verification

`apps/cli` `commands-vision.test.ts` (`npx vitest run --root apps/cli
commands-vision.test.ts`, 15 passing): `looksLikeImage` accepts
PNG/JPEG/GIF/BMP/WebP/HEIC magic and rejects text / `%PDF` / empty;
the local-path branch reads+encodes a real image file but rejects a
`notes.txt` with "doesn't look like an image". A pre-existing
`program.test.ts` vision-helper test that used a `"hello"` fixture as a
fake `.png` was updated to real PNG magic bytes (it was relying on the
absent guard). Mutation-proven: dropping the local-path
`looksLikeImage` check fails the non-image-rejection test; restored
green. `pnpm check` green (apps/cli 1661, apps/api 323); `pnpm lint`
0/0. The guard runs BEFORE the Ollama call — no model round-trip
touched, so no smoke:live (Ollama down regardless).

## Decisions

- Magic-byte sniff rather than extension trust: a user can pass
  `photo` (no extension) or a mislabeled `.png` that's actually text;
  the bytes are the truth, and it matches how `commands-read` /
  `watch-folder` already sniff content.
- Accepted the `ftyp` family broadly (HEIC/AVIF are valid vision
  inputs) even though it also matches MP4/MOV containers — admitting a
  rare video mistype is better than rejecting a real HEIC photo, and
  the model handles an unsupported container far better than mojibake.
- Left the remote branches untouched — they already guard via base64
  validation / content-type, and the gap was solely the local path.
