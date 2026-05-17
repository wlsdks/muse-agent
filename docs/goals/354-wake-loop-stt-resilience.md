# 354 — a transient STT failure crashed the whole `muse listen --wake` session

## Why

`muse listen --wake` is the ambient JARVIS mode — "listen
**continuously** … Ctrl-C to stop". Its `while (active)` loop
records a clip, transcribes it, scans for the wake phrase, and
loops. The loop body carefully wraps the failure-prone calls:

- `captureWavForSeconds` → `try/catch` (logs, breaks);
- the follow-up prompt capture+STT → `try/catch` (logs, breaks);
- `runVoiceTurn` → `try/catch` (logs, **continues**).

But the **main per-clip `providers.stt.transcribe(...)`** had
**no error handling at all**:

```ts
const stt = await providers.stt.transcribe({ … });
const transcript = stt.text.trim();
```

A transient transcription failure — an OpenAI-Whisper network
blip / 5xx / timeout, a whisper.cpp child hiccup — therefore
**propagated uncaught out of the loop and ended the entire
continuous wake session**. For an ambient assistant a single
network glitch silently killing "always listening" is a real
robustness defect; the correct behaviour (already used 3 lines
below for `runVoiceTurn`) is log-and-keep-listening.

## Scope

`apps/cli/src/commands-listen.ts`:

- New exported pure `safeTranscribe(stt, request, io)` →
  `Promise<string | undefined>`: returns the trimmed transcript,
  or — on **any** throw — logs
  `transcription failed (resuming listen): <detail>` to stderr
  and returns `undefined`. The wake loop calls it for the main
  clip and `continue`s when it is `undefined`/empty.
- Exported pure (the established 346/352 boundary-helper
  pattern) because the `while(active)` loop has no
  SIGINT-terminating test harness; this makes the resilience
  contract directly unit-testable.

Behaviour-preserving on success — `safeTranscribe` returns the
exact same `text.trim()`; the only change is that a throw now
resumes the loop instead of crashing it. The follow-up-STT
`break`-on-error (which shares the sox-capture catch and has its
own rationale) is intentionally left alone — out of this tight
scope, noted honestly rather than silently widened.

## Verify

- New `apps/cli/src/commands-listen.test.ts` (the command had
  **no test**): 3 cases — success → trimmed text, **no**
  stderr; a throwing STT → resolves `undefined` (does **not**
  propagate, so the wake loop survives) and logs
  "transcription failed (resuming listen)" + the cause;
  whitespace-only clip → `""` (caller treats as skip).
- `pnpm --filter @muse/cli test` — 608 pass (+3). `pnpm check`
  — every workspace green (apps/cli 611 incl. the test/ glob,
  apps/api 161, all packages). `pnpm lint` — exit 0. The
  goal-227 enforcement test (328) stays green; the test file
  self-scans clean.
- No real-LLM request/response path touched — `safeTranscribe`
  wraps the existing `transcribe` call; the success flow is
  byte-identical, only a catch was added. The deterministic
  helper test is the rigorous verification (a live run cannot
  deterministically inject a transient STT failure).

## Status

done — the continuous `muse listen --wake` loop now survives a
transient per-clip STT failure (logs and resumes listening)
instead of the whole ambient session crashing on the first
network blip, consistent with how `runVoiceTurn` failures are
already handled. The previously-untested listen command now has
direct coverage of the resilience contract.
