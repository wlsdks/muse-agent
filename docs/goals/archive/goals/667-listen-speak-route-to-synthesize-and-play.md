# 667 — `muse listen`'s reply-speak path routes through `synthesizeAndPlay` instead of an inline synth+mkdtemp+play that only `unlinkSync`'d the audio FILE (leaving the `/tmp/muse-listen-*` directory behind) — the last of the three `--speak` temp-dir leaks goal 666 deferred

## Why

`apps/cli/src/commands-listen.ts:runVoiceTurn` (the
voice-loop reply-speak path) inlined the
synth → write-temp-file → play flow:

```ts
const tts = await providers.tts!.synthesize({ text: reply, voice, format });
const dir = mkdtempSync(pathJoin(tmpdir(), "muse-listen-"));
const audioFile = pathJoin(dir, `reply.${tts.format}`);
writeFileSync(audioFile, tts.audio);
try { await shells.playAudio(audioFile); }
finally { try { unlinkSync(audioFile); } catch { /* best-effort */ } }
```

The `finally` removed the audio FILE but **not the
`mkdtemp` directory**. Every voice-loop turn left an empty
`/tmp/muse-listen-XXXXXX/` dir behind. `muse listen` is an
interactive loop — a multi-turn conversation accumulates one
empty dir per spoken reply.

This was the last of the three `--speak` surfaces with a
temp-dir issue:

- `muse brief --speak` — fixed (goal 662)
- `muse proactive --speak` — fixed (goal 666)
- `muse listen` reply-speak — **this iter**

Goal 666's Remaining Risks explicitly flagged it:

> `commands-listen.ts:119` still has the
> unlink-file-but-not-dir pattern (a smaller leak: one
> empty dir per ambient-wake clip). Sibling-fixable by
> routing through `synthesizeAndPlay`.

The canonical `voice-playback.ts:synthesizeAndPlay(tts,
options, shells?)` (goal 630) does the full synth + write +
play + `rmSync(dir, recursive)` cleanup, accepts a custom
`shells` (3rd param), and its `SynthesizeAndPlayOptions`
already carries `text / voice / format` — a drop-in for the
listen path.

### Defect class

**Route an inline copy through the shared helper that
already has the fix (DRY + temp-dir cleanup)** — same shape
as goals 666 (proactive) and 663 (embed). A `fix:` because
it closes a real reachable leak.

Recent 10-iter window:

- 666: proactive --speak → synthesizeAndPlay
- 665: execution-layer clamp
- 664: config upper bound
- 663: refactor DRY (route to shared embed)
- 662: mkdtempSync cleanup (brief --speak)
- 661: concurrent RMW race
- 660: Promise.race timer leak
- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)

## Slice

- `apps/cli/src/commands-listen.ts`:
  - Replaced the inline synth+mkdtemp+write+play+unlink
    block in `runVoiceTurn` with a single
    `await synthesizeAndPlay(providers.tts!, { text: reply,
    voice?, format? }, shells)`.
  - The listen `shells` object (which has `playAudio` plus
    `which` / `spawnRec` / `waitForEnter`) is structurally
    assignable to `synthesizeAndPlay`'s `SpeakerShells`
    (which requires only `playAudio`).
  - Dropped the now-unused imports: `node:fs`
    (`mkdtempSync` / `writeFileSync` / `unlinkSync`),
    `node:os` (`tmpdir`), `node:path` (`pathJoin`). Added
    `synthesizeAndPlay` to the existing `voice-playback.js`
    import (which already brought `parseAudioFormat`).
- `apps/cli/test/program.test.ts`:
  - The listen round-trip test asserted the played file
    ended with `reply.mp3`. `synthesizeAndPlay` names its
    temp file `out.<format>` — an internal detail. Updated
    the assertion to `.endsWith(".mp3")` (asserts the
    requested format, not the helper's arbitrary basename)
    with a WHY comment.

## Verify

- `pnpm --filter @muse/cli test`: 1131 passed (unchanged
  count — pure refactor; one assertion loosened from a
  hardcoded basename to the format extension). Full `pnpm
  check`: every workspace green; tsc strict EXIT=0.
- **Proof of preservation rests on the helper's tests**:
  `voice-playback.test.ts` has the two `synthesizeAndPlay`
  cleanup tests (goal 630) — "removes the mkdtemp dir … on
  every TTS play" and "removes the dir EVEN when playAudio
  throws". The listen reply-speak path now inherits both.
  The listen round-trip test (capture → STT → chat → TTS →
  play) still passes, proving the call-site wiring (STT
  bytes, chat body, TTS voice/format, played file) is
  preserved end-to-end.
- `pnpm lint`: 0 errors / 0 warnings (the dropped imports
  would have tripped `no-unused-vars` if left).
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the two touched files: clean.
- No LLM request/response wire path touched. The TTS synth
  is stubbed in the round-trip test; the helper's cleanup
  is covered by its own tests. `smoke:live` doesn't apply.

## Status

Done. All three `--speak` surfaces now clean up their temp
dirs through the canonical, tested `synthesizeAndPlay` (or
its brief-local sibling):

| Surface                  | Pre-fix                          | Post-fix                              |
| ------------------------ | -------------------------------- | ------------------------------------- |
| `muse brief --speak`     | leaked dir+file (goal 662)       | cleaned via `playSynthesizedAudio`    |
| `muse proactive --speak` | leaked dir+file (goal 666)       | cleaned via `synthesizeAndPlay`       |
| `muse listen` reply      | **leaked empty dir (this iter)** | cleaned via `synthesizeAndPlay`       |

`muse listen` is interactive: a long voice conversation
left one `/tmp/muse-listen-*` empty dir per reply. Post-fix:
zero leaks.

## Decisions

- **Routed through `synthesizeAndPlay`**, the same helper
  goal 666 used for proactive. The listen path already had
  the `shells.playAudio` abstraction that `SpeakerShells`
  expects, so it's a clean structural fit — no adapter
  needed.
- **Loosened the test assertion** from `reply.mp3` to
  `.mp3`. The temp basename is an internal detail of
  whichever helper writes it; the test should pin the
  observable contract (the audio format the user
  requested), not the helper's arbitrary filename. A WHY
  comment records the rationale.
- **Dropped three node built-in imports** — they were only
  used by the inline copy. `synthesizeAndPlay` encapsulates
  all the filesystem work now.
- **No new test added** — pure refactor to an
  already-tested helper, same rationale as goals 663 / 666.
  The cleanup behavior is proven by `voice-playback.test.ts`;
  the call-site wiring is proven by the unchanged listen
  round-trip test.
- **No mutation step** — the behavior-preserving proof is
  the unchanged test suite + the helper's existing cleanup
  tests (the "mutation" would be reverting to the inline
  copy, which the helper's dir-cleanup tests already cover
  for the leak symptom).

## Remaining risks

- **No `--speak` surface leaks temp dirs anymore.** All
  three now route through a helper with `finally`-block
  `rmSync(dir, recursive)` cleanup. The temp-dir-leak
  defect class is closed across the CLI's voice surfaces.
- **`synthesizeAndPlay`'s `out.<format>` basename** is now
  the single naming convention across all speak paths.
  Consistent; no per-surface drift.
- **The listen loop's per-turn synth** still blocks on
  `tts.synthesize` (OpenAI/Piper) with whatever timeout the
  TTS provider enforces. That's the TTS provider's
  concern, not the temp-file lifecycle this iter addressed.
- **`shells.playAudio` in listen** wraps a watchdog-bounded
  player (`playAudioWithWatchdog`), so a wedged player is
  killed and `synthesizeAndPlay`'s `finally` still cleans
  up — verified by the helper's "removes the dir EVEN when
  playAudio throws" test.
