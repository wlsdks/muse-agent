# Goal 920 — `muse listen` (push-to-talk) fails a transcribe cleanly, not as a raw throw

## Outward change

When the speech-to-text step of `muse listen` fails — a missing
whisper model, corrupt audio, a backend hiccup — the command now prints
`transcription failed: <reason>` and exits 1, the same clean ending as
its sibling failures in the same flow (sox crash, empty capture).
Before, the transcribe call was the one unguarded step: any STT throw
propagated raw out of the action as an unhandled error/stack, with no
clear message. Transcription is the most failure-prone step (the local
whisper model may not be pulled yet), so it was the worst one to leave
ungraceful.

## Why this, now

Voice-resilience consistency, completing the thread of 881/882. The
continuous `--wake` loop already routes BOTH its transcriptions through
`safeTranscribe` (882), and the push-to-talk flow's other failure
points (sox exit, zero-byte capture) each give a clean
`command.error(..., { exitCode: 1 })`. The single-shot push-to-talk
transcribe was the lone path that didn't — a real cross-path
inconsistency on a daily voice surface, where the failure mode (model
not installed) is common on a fresh setup.

## How

Wrapped the `providers.stt.transcribe(...)` call in the push-to-talk
action in try/catch. On failure it logs `transcription failed: <msg>`
to stderr and calls `command.error("transcription failed", { exitCode:
1 })` + returns — mirroring the sox / empty-capture handling right
above it. NOT `safeTranscribe` (whose `undefined`→resume semantics fit
the wake LOOP); a single-shot capture should end cleanly, not silently
run the agent on an empty transcript. The success path is unchanged.

## Verification

`apps/cli` `commands-listen.test.ts` (`npx vitest run --root apps/cli
commands-listen.test.ts`, 6 passing): a new push-to-talk test injects a
throwing STT (`whisper model not found`) through the existing
mic→STT→agent harness (fake `spawnRec` emitting WAV bytes,
`exitOverride`), and asserts the run rejects with `transcription
failed: whisper model not found` on stderr AND that `/api/chat` was
NOT called (a failed transcribe must not reach the agent). The
existing round-trip + wake-resilience tests stay green. Mutation-proven:
reverting to the unguarded `await providers.stt.transcribe(...)` fails
the new test (raw throw, no clean error); restored green. `pnpm lint`
0/0; apps/cli alone fully green (151 files / 1673 tests; the 2 parallel
`pnpm check` failures are the known mkdtemp `/tmp` flake); apps/api
323. Deterministic error-handling — the STT provider call is
unchanged, no LLM round-trip — so no smoke:live (Ollama down
regardless).

## Decisions

- Used `command.error` + a clean stderr line (matching the sibling
  sox/empty-capture failures) rather than `safeTranscribe`: push-to-talk
  is single-shot, so the right outcome is "tell the user + exit", not
  the wake loop's "skip this clip and keep listening".
