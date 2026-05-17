# 296 — local Piper TTS had no spawn timeout (295 sibling)

## Why

The direct sibling goal 295 flagged: Piper's `defaultRunner` has
the same no-timeout shape as whisper-cpp pre-295.
`PiperTtsProvider` is the **local, free** TTS — the "Muse speaks
back" path a Qwen-only zero-cost JARVIS uses. `defaultRunner`
spawned the binary with no timeout:

```ts
const child = spawn(binary, [...args], …);
child.on("error", reject);
child.on("close", (exitCode) => resolve({ exitCode, stderr }));
child.stdin?.write(stdin); child.stdin?.end();
```

If `piper` wedges (stuck ONNX voice load, wedged inference),
`close` never fires, the promise never settles, and
`synthesize()` plus the whole voice-output loop hang forever with
no recovery — the same CLAUDE.md "tool loops have explicit
limits and timeouts" non-negotiable violation 295 closed for STT,
on the symmetric TTS side.

## Scope

`packages/voice/src/piper.ts` — identical pattern to goal 295:

- Replace the standalone `defaultRunner` with an exported
  `createPiperRunner(timeoutMs)` factory: a `setTimeout` arms a
  `SIGKILL` of the child and the promise rejects with a clear
  `piper timed out after <ms>ms and was killed` message; the
  timer is cleared on `error`/`close`. The stdin write/end is
  preserved unchanged. `synthesize()`'s existing runner-throw
  catch surfaces it (no infinite hang).
- New `timeoutMs` option (positive-finite-guarded, same posture
  as goals 263/284/295), default **120 s** (covers cold ONNX
  voice load). Only the built-in runner is bounded; an injected
  `runner` owns its own lifecycle (unchanged test seam). One
  short WHY comment records the hang rationale.
  `createPiperRunner` re-exported from the barrel.

Behaviour-preserving: a normally-exiting process resolves
exactly as before (timer cleared on `close`, stdin still piped);
only a process outliving `timeoutMs` is now killed instead of
hanging.

## Verify

- `pnpm --filter @muse/voice test` — 63 pass (was 61; +2). New
  tests use a **real** child: a never-exiting `setInterval`
  with `timeoutMs: 120` rejects with the timeout message in
  < 5 s (proves the child is actually killed); a fast
  `process.exit(0)` still resolves `exitCode: 0`. The existing
  Piper modelPath / argv / stdin-pipe / exit-code / output-missing
  tests (all inject a fake `runner`, bypassing the default) stay
  green.
- `pnpm check` — every workspace green (voice 63, apps/cli 563,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (TTS process-spawn
  lifecycle). A live Qwen run cannot reproduce a wedged piper on
  demand, so the deterministic real-hung-child timeout test is
  the rigorous verification — same stance as the timeout/limit
  goals 295 / 263 / 284.

## Status

done — the local Piper TTS spawn now has a hard, configurable
wall-clock timeout that SIGKILLs a wedged binary and fails fast,
so a stuck synthesis can no longer hang the voice-output loop
forever. Normal synthesis is unchanged. Both local voice spawn
paths (STT 295, TTS 296) are now timeout-bounded, closing the
no-spawn-timeout class across the voice package.
