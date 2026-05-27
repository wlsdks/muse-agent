# 432 — OpenAI Whisper STT enforces its advertised formats (431 sibling)

## Why

Step-3 continuity / consistency fix. Goal 431 made
`WhisperCppSttProvider` enforce its advertised
`describe().supportedFormats`. Its sibling
`OpenAIWhisperSttProvider` — the other concrete `SpeechToText
Provider` adapter behind the same abstraction — had the
**identical** gap: it validates `EMPTY_AUDIO` + `MISSING_MIME_TYPE`
and publishes a 7-format `SUPPORTED_FORMATS` via `describe()`, but
went straight from the missing-mime guard to building the
multipart form, so an unsupported mime was POSTed to the API and
came back as a cryptic 400 instead of an actionable error.

The whole point of the `SpeechToTextProvider` abstraction is
uniform behaviour across adapters; leaving one enforcing and one
not is itself the inconsistency (the 429/419→420 class — fix one,
then the sibling carrying the identical concrete gap). This is
the pre-identified parallel from 431, not new surface.

(`OpenAIWhisperSttProvider` is a paid cloud adapter and not the
project's operative path under the Qwen-only / cost-zero mandate,
but it is shipped, tested code; this is a deterministic
input-validation consistency fix exercised entirely with a fake
`fetch` — no real API call, no cost.)

## Slice

- `packages/voice/src/openai-whisper.ts` — after the missing-mime
  guard, the byte-identical gate goal 431 added to the local
  adapter: normalise the mime (strip `; codecs=…`, trim,
  lowercase) and throw `VoiceValidationError("UNSUPPORTED_FORMAT",
  "unsupported audio format \"<mime>\"; supported: <list>")`
  before any `fetch`. Every advertised format (incl. with a
  `;codecs=` parameter) still passes; only genuinely-unsupported
  input — previously an opaque API 400 — is now a defined,
  actionable rejection.
- `packages/voice/test/voice.test.ts` — regression in the
  `OpenAIWhisperSttProvider` describe mirroring 431's: an
  unsupported mime → `UNSUPPORTED_FORMAT` `VoiceValidationError`
  AND `fetch` never called; a supported `audio/wav; codecs=1`
  still POSTs and returns. Fails on the pre-fix code.

## Verify

- `@muse/voice` OpenAIWhisper describe 9/9 (+2); full
  `@muse/voice` suite green (68, +2); the existing
  empty/mime/multipart/error tests unchanged (all use supported
  mimes — no regression); tsc strict (voice) clean.
- `pnpm check` EXIT=0, every workspace green (voice 68, api 195,
  cli 737, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Deterministic STT-input validation verified with a fake
  `fetch` (no network, no cost) — not a model request/response
  path; no `smoke:live` applies.

## Status

Done. Both concrete STT adapters (local Whisper.cpp + OpenAI
Whisper) now enforce their advertised `supportedFormats`
identically, returning the same actionable `UNSUPPORTED_FORMAT`
error fail-fast instead of one corrupting the file and the other
POSTing into a cryptic 400. The `SpeechToTextProvider`
abstraction is now behaviourally uniform on this contract. The
431 sibling-parallel is discharged.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a consistency fix to an existing provider,
recorded honestly as a `fix(voice):` change with this backlog
row — not a false metric.

## Decisions

- Byte-for-byte the same gate + error code/shape as goal 431 (not
  a near-variant): the two adapters must be indistinguishable on
  this contract, and a shared exact pattern is the most
  drift-proof way to keep them so (same rationale as the
  413/415/427 single-source fixes).
- Did not extract a shared helper for the two gates this
  iteration: two ~6-line identical guards in sibling adapters is
  under the threshold where a shared util earns its indirection;
  a `voice/src` extraction is a legitimate later refactor slice
  if a third adapter appears, not scope-crept here.
