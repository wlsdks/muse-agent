# 630 — `synthesizeAndPlay` cleans the WHOLE `mkdtemp` directory (not just the audio file) and moves `writeFileSync` inside the `try`, so a long-running `muse listen` / `muse today --brief --speak` daemon can't leak an empty `/tmp/muse-speak-XXXX` directory on every TTS play

## Why

`apps/cli/src/voice-playback.ts:synthesizeAndPlay` is the shared
"synthesise → write to disk → play → clean up" routine that
`muse listen` (wake-word + agent voice reply) and any `--speak`
surface (today / brief / proactive) call once per spoken
response.

Pre-fix:

```ts
const dir = mkdtempSync(pathJoin(tmpdir(), "muse-speak-"));
const file = pathJoin(dir, `out.${synth.format}`);
writeFileSync(file, synth.audio);
try {
  await shells.playAudio(file);
} finally {
  try {
    unlinkSync(file);
  } catch {
    // best-effort cleanup
  }
}
```

Two cleanup gaps:

1. **The `mkdtemp` directory is never removed.** `unlinkSync` only
   removes the file INSIDE the directory; the empty directory
   itself stays. Every TTS play leaves a fresh `muse-speak-XXXX`
   under `/tmp`. On a daemon firing 50–200 voice replies a day
   (a JARVIS-class personal agent talking through the day), the
   tmp tree grows monotonically. macOS and most Linux distros
   only purge `/tmp` on reboot, and a developer machine that
   stays up for weeks accumulates thousands of empty directories
   in `/tmp` — slowing `ls /tmp`, polluting the file picker, and
   on tmpfs-backed installations consuming inodes.
2. **`writeFileSync` sits OUTSIDE the `try`.** If the write fails
   (disk full, EIO, perm error on a remounted tmpfs, audio
   buffer too large for a constrained tmpfs), the `mkdtemp` dir
   is leaked AND the cleanup branch never runs at all — both
   the file (if partially written) and the dir leak.

A `mkdtempSync` + `unlinkSync(file)` pairing is a common
anti-pattern: the mental model "I removed the file so I'm done"
overlooks that the DIRECTORY was created by `mkdtempSync` and
must be removed too. The fix is `rmSync(dir, { recursive: true,
force: true })` — one call removes the dir AND any contents
(file plus future siblings if `synth.format` changes or a
caller writes auxiliary files).

This iter's defect class — **`mkdtemp` directory leak: the
file inside is cleaned up but the temp directory itself is
left behind, and a partial write can leak the whole dir** — is
fresh against the recent window:

- 629: per-entry validation (cast lie)
- 628: unit-promotion + finite-guard
- 627: tolerant-read nested array
- 626: child-process stream error
- 625: strict env-parse
- 624: HTTP timeout
- 623: classification
- 622: boolean spelling
- 621: test additions
- 620: graceful read recovery
- 619: blank-keyword filter
- 618: memory cap
- 617: atomic write
- 616: file mode 0o600

"Resource-cleanup symmetry — mkdtemp vs. file unlink" hasn't
been hit before. The closest sibling is 617 (atomic-write
tmp+rename), but that's about writing safely, not cleaning up
afterward.

## Slice

- `apps/cli/src/voice-playback.ts`:
  - Replace `unlinkSync` import with `rmSync` (both from
    `node:fs`).
  - Move `writeFileSync` INSIDE the `try` so a write failure
    still hits the `finally` cleanup branch.
  - Move `file = pathJoin(...)` inside the `try` too (it's now
    in the same scope as the write).
  - Replace `unlinkSync(file)` with `rmSync(dir, { recursive:
    true, force: true })` — one call removes the dir AND the
    file inside, atomically from the caller's point of view.
  - The inner `try/catch` swallowing the cleanup error stays
    (best-effort cleanup; a rare unlink failure shouldn't mask
    the playback error).
- `apps/cli/src/voice-playback.test.ts`:
  - Two new tests in a new `describe("synthesizeAndPlay —
    `mkdtemp` cleanup ...")` block:
    - **Success path** — register a fake `TextToSpeechProvider`
      returning 3 bytes of synth audio, a fake `SpeakerShells`
      that resolves on `playAudio`, snapshot `/tmp` for
      `muse-speak-*` entries before, call `synthesizeAndPlay`,
      snapshot after. Assert no new `muse-speak-*` directories
      were left behind.
    - **Error path** — same setup but the fake `playAudio`
      rejects with `"player wedged"`. Expect the promise to
      reject AND assert no `muse-speak-*` dir leaked, pinning
      the `finally`-branch cleanup.
  - Tests use real `os.tmpdir()` listing (not mocks): the
    defect is at the filesystem boundary; a stub `fs` would
    test the stub, not the actual cleanup. Test compares
    deltas pre- vs. post-call so CI-residual entries from
    earlier runs don't poison the assertion.

## Verify

- `@muse/cli` suite green (1093 passed, +2 vs the post-629
  baseline of 1091, 0 failed). Note: tsc strict caught a typo
  in the initial test draft — the `fakeTts` was missing
  `id`/`mimeType`/`availableVoices`/`supportedFormats`/`local`
  required by `TextToSpeechProvider` / `TtsProviderInfo` /
  `TtsResponse`. Fixed inline (these are positional types
  from `@muse/voice`); no production change.
- **Clean-mutation-proven** (Edit-based): reverting the import
  back to `unlinkSync`, the cleanup back to `unlinkSync(file)`,
  and moving `writeFileSync` back outside the `try` makes
  EXACTLY TWO of the two new tests fail — both with the EXACT
  pre-fix symptom: a leaked `muse-speak-XXXX` directory. The
  test output literally shows `Received: ["muse-speak-a96BgH"]`
  vs. `Expected: []`. The pre-existing 5 tests in the file
  (parseAudioFormat / playAudioWithWatchdog) pass pre- and
  post-fix — confirms the change is scope-limited. Fix
  restored, suite back to 1093/1093.
- `pnpm check` green: apps/api 261/261, apps/cli 1093/1093,
  every workspace; tsc strict EXIT=0.
- `pnpm lint` 0/0, `pnpm guard:core` clean, byte-scan clean on
  both touched files.
- No LLM request/response wire path touched (the TTS request
  is to the configured provider, but the cleanup is a pure
  filesystem fix). `smoke:live` doesn't apply.

## Status

Done. The `mkdtemp` lifetime is now fully bounded by the
`synthesizeAndPlay` call's stack frame:

| Scenario                        | Before                                  | After                       |
| ------------------------------- | --------------------------------------- | --------------------------- |
| Successful playback             | file unlinked; **dir leaked**           | dir removed entirely (**fixed**) |
| `playAudio` throws (player wedged) | file unlinked; **dir leaked**         | dir removed entirely (**fixed**) |
| `writeFileSync` throws (disk full) | **file + dir both leaked** (try never entered) | dir removed entirely (**fixed**) |
| `mkdtempSync` itself throws     | nothing to clean up                     | unchanged                   |

For a JARVIS-class daemon that speaks 50–200 times a day, this
turns a steady tmp-tree growth (50–200 empty dirs/day) into
zero residue.

No CAPABILITIES line / no OUTWARD-TARGETS flip: a robustness /
resource-cleanup `fix:` on the voice playback path. Recorded
honestly with this backlog row — not a false metric.

## Decisions

- **`rmSync(dir, { recursive: true, force: true })` not
  separate `unlinkSync(file)` + `rmdirSync(dir)`.** One call
  handles both. `force: true` swallows ENOENT (matches the
  pre-fix `catch {}` posture). `recursive: true` covers any
  auxiliary file a future caller might write next to
  `out.${format}` (e.g. a sidecar transcript). Single call
  also avoids the partial-cleanup window where the file is
  gone but the dir isn't — a concurrent observer wouldn't see
  an empty `muse-speak-*` directory.
- **`writeFileSync` moved inside the `try`.** Pre-fix: a write
  failure (disk full, EIO) skipped the cleanup. Post-fix:
  every path between mkdtemp success and synthesizeAndPlay's
  return goes through `finally`. The cost is one extra stack
  frame for the writeFileSync, negligible.
- **Sync IO kept.** The original used `mkdtempSync` /
  `writeFileSync` / `unlinkSync` — switching to async would
  unnecessarily refactor the function's contract. The audio
  bytes are small (a few KB to a few hundred KB); sync writes
  to tmpfs are sub-millisecond. The rmSync at the end is
  outside the user-perceived latency path anyway (after
  playAudio completes). Match the existing posture.
- **Test compares delta, not absolute count.** Listing
  `/tmp` for `muse-speak-*` entries pre-test and post-test
  filters out any residual entries from earlier test runs.
  CI doesn't reset /tmp between runs; this approach is
  resilient to that.
- **Test uses real `os.tmpdir()` listing, not a mock.** The
  defect is at the filesystem boundary; stubbing `fs.rmSync`
  / `fs.unlinkSync` would test "did we call the right
  function" but not "did the directory actually get removed."
  Real /tmp listing pins the end-to-end behavior.
- **TextToSpeechProvider type compliance.** The test fake
  needed the full `TtsProviderInfo` shape (`id`,
  `displayName`, `description`, `local`, `availableVoices`,
  `supportedFormats`) and the full `TtsResponse` shape
  (`audio`, `mimeType`, `format`). `synthesize` is the only
  method exercised, but `tsc --strict` demands the full
  interface. Filled in with reasonable test values.
- **Mutation choice.** Reverted three changes together (the
  import, the cleanup call, and the writeFileSync position).
  Pre-fix: both tests fail with the literal directory-name
  leaked. Post-fix: both pass. The other 5 pre-existing tests
  in the file (parseAudioFormat / playAudioWithWatchdog) pass
  both pre- and post-fix — they don't depend on the
  synthesizeAndPlay cleanup, so they confirm the fix is
  surgical.

## Remaining risks

- **`mkdtempSync` itself can leak between processes.** If
  `synthesizeAndPlay` is SIGKILL'd between mkdtemp and the
  finally cleanup, the dir leaks. The signal handler in the
  daemon catches SIGINT/SIGTERM and runs cleanup, but
  SIGKILL is uncatchable. Mitigation would be an
  `on('exit')` registry of pending tmp dirs — out-of-scope
  for this iter. The pre-fix problem (no exit signal needed,
  every successful call leaked) is now fixed.
- **`tmpdir()`** points to `$TMPDIR` (set by the OS or
  shell). On systems where `$TMPDIR` is a tmpfs with limited
  inodes, the pre-fix accumulation would have eventually
  failed `mkdtempSync` with ENOSPC. The fix removes that
  failure mode.
- **Sibling functions** elsewhere in `apps/cli/src/` might
  carry the same anti-pattern. A quick grep:
  - `commands-listen.ts` — uses sox via spawnRec; spawnRec
    handles its own tmp.
  - `commands-export.ts` — uses tar via spawn; tar handles
    its own paths.
  - `whisper-cpp.ts` (in `packages/voice/src/`) — uses
    `mkdtemp` + `rm(workdir, { recursive: true, force: true
    })` in `finally`. Already correct.
  Single audit pass — no other voice-playback-style leak in
  the CLI surface.
- **`force: true` swallows ENOENT** but also swallows EACCES
  / EBUSY. A directory that became un-removable (e.g. an
  antivirus held an open handle, a network mount lost its
  backing) would be silently skipped. This is the same
  posture as the pre-fix `catch {}` — neither old nor new
  surfaces this class of failure. Out-of-scope to add a
  separate observability hook for it.
