# 295 — local whisper-cpp STT had no spawn timeout (could hang the voice loop forever)

## Why

`WhisperCppSttProvider` is the **local, free** STT path a
Qwen-only zero-cost JARVIS uses for "Hey Muse" — every rolling
voice clip is transcribed through the spawned `whisper-cpp`
binary, and that text feeds both the wake-word detector and the
prompt. The built-in `defaultRunner` spawned the process with
**no timeout**:

```ts
const child = spawn(binary, [...args], …);
child.on("error", reject);
child.on("close", (exitCode) => resolve({ exitCode, stderr }));
```

If `whisper-cpp` wedges — a stuck GGML model load, a hung ffmpeg
decode of a malformed clip, a binary blocked on something —
`close` never fires and the promise **never settles**, so
`transcribe()` and the entire voice loop hang forever with no
recovery. The cloud `OpenAIWhisperSttProvider` rides on `fetch`
(abortable / timeout-capable); the local spawn path had no
equivalent, directly violating the CLAUDE.md non-negotiable
"Tool loops have explicit limits and timeouts."

## Scope

`packages/voice/src/whisper-cpp.ts`:

- Replace the standalone `defaultRunner` with an exported
  `createWhisperCppRunner(timeoutMs)` factory: a `setTimeout`
  arms a `SIGKILL` of the child and the promise rejects with a
  clear `whisper-cpp timed out after <ms>ms and was killed`
  message; the timer is cleared on `error`/`close`. The
  transcribe path's existing runner-throw catch surfaces it (no
  infinite hang; the loop fails fast and can recover).
- New `timeoutMs` option (positive-finite-guarded, same posture
  as goals 263/284), default **120 s** — generous enough to
  cover a cold first-call model load while still bounding a hang.
  Only the built-in runner is bounded; an injected `runner`
  owns its own lifecycle (unchanged test seam). One short WHY
  comment records the hang rationale. `createWhisperCppRunner`
  re-exported from the barrel for direct coverage.

Behaviour-preserving: a normally-exiting process resolves
exactly as before (timer cleared on `close`); only a process
that outlives `timeoutMs` is now killed instead of hanging.

## Verify

- `pnpm --filter @muse/voice test` — 61 pass (was 59; +2). New
  tests use a **real** child: a never-exiting
  `setInterval(()=>{},1000)` with `timeoutMs: 120` rejects with
  the timeout message in < 5 s (proves the child is actually
  killed, not just the assertion timing out); a fast
  `process.exit(0)` still resolves `exitCode: 0`. The existing
  whisper-cpp argv / empty-audio / missing-mime / output-missing
  tests (all inject a fake `runner`, bypassing the default) stay
  green.
- `pnpm check` — every workspace green (voice 61, apps/cli 563,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (STT process-spawn
  lifecycle; the model round-trip is downstream and unchanged).
  A live Qwen run cannot reproduce a wedged whisper-cpp on
  demand, so the deterministic real-hung-child timeout test is
  the rigorous verification — same stance as the timeout/limit
  goals 263 / 284.

## Status

done — the local whisper-cpp STT spawn now has a hard,
configurable wall-clock timeout that SIGKILLs a wedged binary
and fails fast, so a stuck transcription can no longer hang the
"Hey Muse" voice loop forever. Normal transcriptions are
unchanged. (Piper's `defaultRunner` has the same shape — a
follow-up sibling.)
