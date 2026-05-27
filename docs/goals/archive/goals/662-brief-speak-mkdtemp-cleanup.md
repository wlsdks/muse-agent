# 662 — `muse brief --speak` extracts `playSynthesizedAudio` and wraps the `mkdtempSync` body in try/finally + `rmSync(dir, { recursive, force })` so every speak invocation leaves no leftover `/tmp/muse-brief-speak-*` directory — sibling parity with goal 630's voice-playback fix

## Why

`apps/cli/src/commands-brief.ts:speakAloud` (the `--speak`
path for `muse brief`) called:

```ts
const dir = mkdtempSync(pathJoin(tmpdir(), "muse-brief-speak-"));
const audioFile = pathJoin(dir, `brief.${result.format}`);
writeFileSync(audioFile, result.audio);
await playAudioFile(player, audioFile);
```

with **no cleanup**. Every `--speak` invocation left a
`/tmp/muse-brief-speak-XXXXXX/brief.wav` directory + file
behind, forever (until the OS's tmp-reaper ran — typically
once on reboot for macOS, or systemd-tmpfiles' 10-day TTL
on Linux). For a user dogfooding the daily briefing
several times a day, this is N temp dirs per day
accumulating in /tmp.

Same defect class as **goal 630** (voice-playback
`mkdtemp` cleanup, ~31 iters ago). The fix mirrors goal
630's pattern: try/finally around the body, `rmSync(dir,
{ recursive: true, force: true })` in the finally so the
cleanup fires regardless of whether playback succeeds or
the audio player exits non-zero.

The sibling site `apps/cli/src/commands-listen.ts:119`
has a similar pattern but DOES unlinkSync the file (just
not the dir). Out of scope for this iter — single-file
focus. Sibling iter can apply the same `playSynthesizedAudio`
extraction there.

### Defect class

**`mkdtempSync` without cleanup** — last hit goal 630
(31 iters ago, well past the 10-iter rotation window;
0/10 in the recent window). Fresh against the recent
10-iter window:

- 661: concurrent RMW race
- 660: Promise.race timer leak
- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM)
- 655: path-traversal alt-separator
- 654: PKCE feature
- 653: recursion depth bound
- 652: error msg control-char sanitization

## Slice

- `apps/cli/src/commands-brief.ts`:
  - Added `rmSync` to the existing `node:fs` import.
  - **Extracted `playSynthesizedAudio(audio, format,
    options?)`**, exported, with the temp-dir lifecycle
    encapsulated:
    ```ts
    const dir = mkdtempSync(pathJoin(tmpdir(), "muse-brief-speak-"));
    try { ... } finally {
      try { rmSync(dir, { recursive: true, force: true });
      } catch { /* best-effort */ }
    }
    ```
  - Accepts `playerCommand` and `playerSpawn` injection
    seams so tests can pin behavior without spawning real
    `afplay` / `aplay` binaries.
  - Returns `{ dir }` so callers (and tests) can inspect
    the path that was used (and is now deleted) — useful
    for the happy-path assertion.
  - `speakAloud` now calls `playSynthesizedAudio(result.
    audio, result.format)`; its own try/catch around the
    inner `tts.synthesize` + play call is preserved for
    the user-visible `io.stderr` "speak failed" message.
- `apps/cli/src/commands-brief.test.ts`:
  - Added `existsSync` + `dirname` to imports.
  - Added `playSynthesizedAudio` to the named import from
    `./commands-brief.js`.
  - **Two new `it()` blocks**:
    1. **Happy-path cleanup** — fake spawn that emits
       `close 0`. After await, `existsSync(result.dir)`
       is `false`.
    2. **Error-path cleanup** — fake spawn captures the
       audio file path via the spawn args, then emits
       `close 7`. The `playSynthesizedAudio` promise
       rejects. After the rejection, `existsSync(file)`
       AND `existsSync(dirname(file))` are both `false` —
       proves the `finally` runs on the throw branch.

## Verify

- `pnpm --filter @muse/cli test`: 1129 passed (1127 prior
  + 2 new). Full `pnpm check`: 1131 in full sweep, every
  workspace green; tsc strict EXIT=0.
- **Clean-mutation-proven**: removing the try/finally
  block (so the function does mkdtempSync + write +
  play + return without cleanup) makes EXACTLY both
  cleanup tests fail with the exact symptom — the
  audio file and parent dir still exist on disk
  (`existsSync === true` instead of `false`). Restored;
  all green.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. The TTS
  synth call is from `@muse/voice` (Piper / OpenAI Whisper);
  the test stubs it via the fake spawn. `smoke:live`
  doesn't apply.

## Status

Done. `muse brief --speak` no longer leaks temp dirs:

| Run scenario                              | Pre-fix                              | Post-fix                              |
| ----------------------------------------- | ------------------------------------ | ------------------------------------- |
| Player exits 0 (normal)                   | `/tmp/muse-brief-speak-XXX/` stays   | dir + file removed                    |
| Player exits non-zero (audio error)       | `/tmp/muse-brief-speak-XXX/` stays   | dir + file removed (finally fires)    |
| Player times out (BRIEF_AUDIO_PLAYER_TIMEOUT_MS) | `/tmp/muse-brief-speak-XXX/` stays   | dir + file removed (finally fires)    |
| `--speak` invoked 50× per day             | 50 dirs/day accumulate in /tmp       | 0 dirs leak per day                   |

## Decisions

- **Extracted as `playSynthesizedAudio`**, not inlined in
  speakAloud. Two reasons:
  1. Testability — the inner audio-file-and-cleanup
     lifecycle can be unit-tested without spinning up
     the full TTS provider chain.
  2. Reuse — sibling iter that fixes commands-listen.ts
     can call the same helper, avoiding triple-paste.
- **`rmSync` with `{ recursive: true, force: true }`** —
  matches goal 630's exact pattern. Recursive so the dir
  + file go together; force so a missing file (concurrent
  external cleanup) doesn't throw.
- **`try { rmSync(...) } catch { /* best-effort */ }`** —
  rmSync can throw on a permission error or if the dir
  was racing-deleted by another process. The cleanup is
  best-effort; the function's contract is "play the
  audio", not "guarantee the dir is gone". Same posture
  as goal 645's `fs.chmod(file, 0o600).catch(...)`.
- **`return { dir }` for inspection**. Caller doesn't
  use it in production (speakAloud discards it), but
  tests need the path to assert non-existence. Cheap
  bookkeeping.
- **`playerSpawn` injection seam**. Same shape the
  existing `playAudioFile(player, audioFile, spawnFn?)`
  uses. Tests pass a fake EventEmitter-based spawn that
  emits `close` events synchronously.
- **Did NOT fix the sibling `commands-listen.ts:119`
  site in this iter**. That site DOES `unlinkSync` the
  file, just not the dir. Lower leakage (a single empty
  dir per ambient-wake clip), but still leaks. Sibling
  iter can route it through `playSynthesizedAudio` too.
- **Mutation choice**. Reverted only the try/finally
  block. Both new tests fail with the exact "file/dir
  still exists" symptom; the 5 existing `playAudioFile`
  tests pass regardless. Surgical proof.

## Remaining risks

- **Race with external tmp-reaper**: a fast-running
  `systemd-tmpfiles` could delete our dir between
  mkdtemp and our final rmSync. The `force: true` flag
  in rmSync absorbs the resulting ENOENT — no error.
- **`commands-listen.ts:119`** still has the
  unlink-file-but-not-dir pattern. Sibling iter can
  apply.
- **Other `mkdtempSync` callsites in the CLI**:
  - `apps/cli/src/commands-proactive.ts:231` — proactive
    daemon's `--speak` mode. Same defect class. Could
    sibling-apply `playSynthesizedAudio`.
  - Test-file mkdtempSync calls are not subject to this
    rule (they're per-test-lifetime; vitest cleans).
- **The 30-second watchdog `BRIEF_AUDIO_PLAYER_TIMEOUT_MS`**
  is unchanged. With the SIGKILL, the player exits and
  the finally fires — verified implicitly by the
  player-timeout test in the existing suite.
