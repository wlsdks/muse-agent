# Goal 882 — wake-word follow-up transcription resumes on a transient STT failure

## Outward change

In `muse listen --wake "<phrase>"` (continuous ambient mode), a
transient STT failure (network blip, 5xx, whisper.cpp hiccup) while
transcribing the **follow-up prompt** — the clip captured right
after the wake word fires — no longer crashes the whole ambient
session. It now logs and resumes listening, exactly like a failure
on the wake clip itself. A flaky transcription endpoint can no
longer silently end a "hey muse" session the user believes is still
running.

## Why this, now

`safeTranscribe` exists precisely to honour the documented contract:
*"a transient STT failure must resume listening, not crash the whole
continuous wake session."* The **first** (wake-detection) clip went
through it. But the **follow-up** prompt transcription called
`providers.stt.transcribe(...)` directly, inside a `try/catch` that
`break`s the loop AND mislabels the failure as `sox error during
prompt capture` — so a pure STT error killed the session and pointed
the user at the wrong subsystem. A real correctness bug on a fresh
surface (voice STT/capture, distinct from the just-touched playback).

## How

Split the follow-up branch's single `try` into two concerns:

- **sox capture** (`captureWavForSeconds`) keeps its `catch → break`
  — a dead microphone genuinely ends the session.
- **transcription** now routes through `safeTranscribe`, which
  catches transient failures, logs `transcription failed (resuming
  listen)`, and returns `undefined`; an `undefined`/empty result
  `continue`s the loop (resume) instead of breaking it.

This makes the follow-up path identical to the wake-clip path.

## Verification

`apps/cli` `commands-listen.test.ts`: a new wake-mode integration
test drives `registerListenCommand` with injected shells + STT
provider — clip 1 transcribes to "hey muse" (wake fires, no
residual → follow-up capture), the follow-up transcription throws a
transient error, and the test asserts the session **resumed**
(captured a third ambient clip; `recCalls === 3`) and that stderr
shows `transcription failed (resuming listen)`, NOT `sox error
during prompt capture`. Mutation-proven: reverting to the
direct-transcribe-in-break-catch fails the test (`recCalls === 2`,
wrong message). `safeTranscribe`'s own unit suite is unchanged and
green. No LLM path → no smoke:live; Ollama down regardless. `pnpm
check` exit 0, `pnpm lint` 0/0.

## Decisions

- Reused the existing `safeTranscribe` rather than a second catch —
  one resilience seam, identical behaviour on both transcription
  sites.
- The fake `rec` self-closes via `setImmediate` so the test doesn't
  wait on the real per-clip `setTimeout`; tsc required the
  `as unknown as ChildProcess` cast (vitest's esbuild ignored the
  structural mismatch — caught only at `pnpm check`).
