# 367 — shared `defaultSpeakerShells` audio player had no spawn watchdog

## Why

Goal 366 closed the unguarded `afplay` / `aplay` spawn in
`commands-brief.ts`'s `speakAloud`. Auditing **every** `spawn(` call
site for the blessed single-settle + SIGKILL watchdog surfaced a
second instance of the exact same bug — and a higher-leverage one,
because it lives in the **shared** speaker helper:

`apps/cli/src/voice-playback.ts` `defaultSpeakerShells().playAudio`
spawned the player and awaited a Promise that **only settled on
`child.once("error")` / `child.once("close")`** with no timeout. This
helper is the production speaker path for `synthesizeAndPlay`, used by
`muse today --brief --speak` (`commands-today.ts:302`) and documented
as the reuse point for "any future surface that wants to render text
through speakers". A wedged player — a busy CoreAudio / ALSA device,
a stuck process — would hang every such command **forever** with no
recovery, identical to the goal-366 failure mode but on the path
multiple surfaces share.

The audit (`grep` of all non-test `spawn(` sites, then per-file
`SIGKILL` / `setTimeout` / `settled` markers) confirms the remaining
unguarded sites are non-LLM, non-interactive utilities (tar
extract/list in import/export, `muse show` image-open); the
audio-player class — the one that actually wedges in practice on a
busy sound device — is now fully closed across `commands-brief.ts`
(366) and the shared `voice-playback.ts` (this goal).

## Scope

`apps/cli/src/voice-playback.ts`:

- New exported `AUDIO_PLAYER_TIMEOUT_MS = 30_000` and pure,
  injectable `playAudioWithWatchdog(player, filePath, spawnFn =
  spawn)` carrying the exact blessed pattern: `settled` flag +
  `finish(action)` that `clearTimeout`s once + a `setTimeout` that
  `child.kill("SIGKILL")`s then rejects, with `error` / `close`
  routed through `finish` so a late close from the killed child
  can't flip the result. `stdio` and the `${player} exited with code
  …` / spawn-error messages are preserved byte-for-byte, so
  happy-path and error-path behaviour are unchanged.
- `defaultSpeakerShells()` now delegates `playAudio` to
  `playAudioWithWatchdog(...)`. The only behaviour change is that a
  wedged player is SIGKILLed after 30 s instead of hanging the
  command indefinitely.

New cases in `apps/cli/src/voice-playback.test.ts` (5, mirroring the
blessed `commands-glance.test.ts` / goal-366 watchdog suites via a
fake-spawn `EventEmitter`): resolve on exit 0; reject with the exit
code on non-zero; reject on a spawn error (player not installed);
SIGKILL + reject after the 30 s timeout; no double-settle (a late
`close` after the timeout is ignored). The previously
spawn-untestable `defaultSpeakerShells` path is now covered through
the injectable helper.

## Verify

- `pnpm --filter @muse/cli test` — 642 pass (+5; 55 suites).
- `pnpm check` — every workspace green (apps/cli 647 incl. the
  `test/` glob, apps/api 165, all packages).
- `pnpm lint` — exit 0.
- goal-227/328 byte scan clean on both touched files (the goal-328
  enforcement test stays green).
- No real-LLM request/response path touched — only the audio-player
  child-process spawn; `tts.synthesize` / `synthesizeAndPlay`'s synth
  call is untouched. The deterministic fake-spawn suite (incl.
  fake-timer timeout + double-settle) is the rigorous verification.

## Status

done — `muse today --brief --speak` and every other
`synthesizeAndPlay` consumer can no longer hang forever on a wedged
`afplay` / `aplay`; the shared spawn is SIGKILLed after 30 s and is a
pure, directly-tested helper. The audio-player spawn class is now
fully guarded across the brief and shared-speaker paths.
