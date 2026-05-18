# 366 — `muse brief --speak` audio player had no spawn watchdog

## Why

`muse brief` is a JARVIS-defining feature (the walk-into-the-lab
morning ritual). Its `--speak` path synthesizes the brief via TTS,
writes a temp audio file, and plays it through the system speaker
(`afplay` on macOS, `aplay` on Linux). The spawn awaited a Promise
that **only settled on `child.on("error")` / `child.on("close")`**:

```ts
await new Promise<void>((resolve, reject) => {
  const child = spawn(player, [audioFile], { stdio: "ignore" });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(...));
});
```

There was **no timeout / watchdog**. If the player wedges — a busy
or stuck CoreAudio / ALSA device, an unresponsive audio process —
neither `error` nor `close` ever fires, the Promise never settles,
and `muse brief --speak` hangs **forever** with no recovery. The
codebase already established the single-settle + SIGKILL
child-process watchdog pattern and applied it broadly
(`commands-glance.ts` `runOsascript`, `macos-provider.ts`,
`notes-providers-apple.ts`, `tasks-providers-apple.ts`,
`macos-notification-provider.ts`, `linux-libnotify-provider.ts`,
`muse-tools-skills.ts`, `runner.ts`). This `speakAloud` spawn — in a
command that had **no test file** — was the one that slipped through
that sweep.

## Scope

`apps/cli/src/commands-brief.ts`:

- New exported `BRIEF_AUDIO_PLAYER_TIMEOUT_MS = 30_000` and pure,
  injectable `playAudioFile(player, audioFile, spawnFn = spawn)`
  carrying the exact blessed pattern: `settled` flag +
  `finish(action)` that `clearTimeout`s once + a `setTimeout` that
  `child.kill("SIGKILL")`s then rejects, with `error` / `close`
  routed through `finish` so a late close from the killed child
  can't flip the result.
- `speakAloud` now delegates to `playAudioFile(player, audioFile)`.
  Outward behaviour on the happy path is unchanged (resolve on exit
  0, reject → caught and printed as `(speak failed: …)`); the only
  change is that a wedged player is now killed after 30 s instead of
  hanging the command indefinitely.

New `apps/cli/src/commands-brief.test.ts` (5 cases, mirroring the
blessed `commands-glance.test.ts` watchdog suite via a fake-spawn
`EventEmitter`): resolve on exit 0; reject with the exit code on
non-zero; reject on a spawn error (player not installed);
SIGKILL + reject after the 30 s timeout; no double-settle (a late
`close` after the timeout is ignored).

## Verify

- `pnpm --filter @muse/cli test` — 632 pass (+5; new file, 54
  suites).
- `pnpm check` — every workspace green (apps/cli 637 incl. the
  `test/` glob, apps/api 165, all packages).
- `pnpm lint` — exit 0.
- goal-227/328 byte scan clean on both touched files (the goal-328
  enforcement test stays green).
- No real-LLM request/response path touched — only the audio-player
  child-process spawn. The brief's `modelProvider.stream` path is
  untouched. The deterministic fake-spawn suite (incl. fake-timer
  timeout + double-settle cases) is the rigorous verification.

## Status

done — `muse brief --speak` can no longer hang forever on a wedged
`afplay` / `aplay`; the audio player is SIGKILLed after 30 s, and the
spawn/await logic is a pure, directly-tested helper instead of
untestable inline glue, closing the last child-process spawn that
the 339–341 watchdog sweep missed.
