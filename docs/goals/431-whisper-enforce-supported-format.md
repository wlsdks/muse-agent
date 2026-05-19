# 431 — Whisper.cpp STT enforces its advertised supported formats

## Why

Consistency + error-UX fix on a fresh axis (`@muse/voice`
`WhisperCppSttProvider` — the cost-zero local STT path the
project mandates; not touched by the recent cli/api/observability
cluster).

`transcribe()` validates two of the three input properties with a
clear, actionable `VoiceValidationError` (empty audio →
`EMPTY_AUDIO`, missing mime → `MISSING_MIME_TYPE`) — but it does
**not** enforce its own `describe().supportedFormats`. Any other
mime fell through `extensionForMime`'s `else → "wav"` branch, so
e.g. an iOS voice memo (`audio/x-m4a`) was written to disk as
`input.wav` and handed to whisper-cpp, whose native WAV reader
then failed with a cryptic `EXIT_<n> …` (or, on an ffmpeg build,
mis-sniffed). The provider thus *advertised* a 7-format contract
it didn't *enforce*, and a wrong-format call got an opaque exit
code instead of an actionable error — inconsistent with the
function's own validate-then-act discipline (the 429 class:
advertised-but-unenforced contract).

## Slice

- `packages/voice/src/whisper-cpp.ts` — after the missing-mime
  guard, normalise the mime (strip a `; codecs=…` parameter,
  trim, lowercase) and, if it is not in `SUPPORTED_FORMATS`,
  throw `VoiceValidationError("UNSUPPORTED_FORMAT", "unsupported
  audio format \"<mime>\"; supported: <list>")` — fail fast,
  before `mkdtemp` / spawn, exactly like the sibling empty/mime
  guards. Every previously-advertised format still passes
  (incl. with a `;codecs=` parameter); only genuinely
  unsupported input is now rejected with a clear message
  instead of a corrupt `.wav` + cryptic whisper-cpp failure.
- `packages/voice/test/voice.test.ts` — regression in the
  `WhisperCppSttProvider` describe: `audio/x-m4a` →
  `VoiceValidationError` `UNSUPPORTED_FORMAT` AND the runner is
  never spawned; a supported `audio/wav; codecs=1` is still
  accepted end-to-end (proves the `;`-param normalisation isn't
  over-strict).

## Verify

- `@muse/voice` WhisperCpp describe 12/12 (+2); full
  `@muse/voice` suite green (66, +2); the existing wav/argv/
  exit-code/timeout tests unchanged (all use supported mimes —
  no regression); tsc strict (voice) clean.
- `pnpm check` EXIT=0, every workspace green (voice 66, api 195,
  cli 737, …); `pnpm lint` 0/0; `pnpm guard:core` clean;
  byte-scan clean; `git status` shows only the two intended
  files.
- Deterministic STT-input validation verified with a fake
  runner (no model spawned) — not a model request/response
  path; no `smoke:live` applies.

## Status

Done. A caller (or the agent's voice loop) handing
`WhisperCppSttProvider` a format outside its advertised set now
gets an immediate, actionable `UNSUPPORTED_FORMAT` error naming
the supported list, instead of a corrupt-extension write and an
opaque whisper-cpp exit code. `describe().supportedFormats` is
now an enforced contract, consistent with the function's own
empty/mime validation.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets are
already `[x]`; a consistency/error-UX fix to an existing
provider, recorded honestly as a `fix(voice):` change with this
backlog row — not a false metric.

## Decisions

- Enforce the exact `SUPPORTED_FORMATS` list (not a looser
  "looks audio-ish" heuristic): the provider already publishes
  that precise set via `describe()`, so making it the gate turns
  an advertised contract into an enforced one with zero new
  surface — converting prior undefined behaviour (corrupt write
  / cryptic exit) into a defined, actionable rejection, not a
  regression of any documented capability.
- Did not expand `SUPPORTED_FORMATS` to add m4a/aac: that would
  be speculative feature-creep without an observed working path
  (whisper.cpp's native reader is WAV; non-WAV needs a specific
  build) — out of scope for this consistency fix.
