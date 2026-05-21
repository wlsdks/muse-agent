# 666 — `muse proactive --speak` routes through the canonical `synthesizeAndPlay` helper instead of reimplementing the synth+mkdtemp+play flow inline (which leaked a `/tmp/muse-proactive-speak-*` directory on every notice) — closes the temp-dir leak goal 662's remaining-risks deferred

## Why

`apps/cli/src/commands-proactive.ts` (the `--speak` mode of
the proactive surfacing daemon) built its `speakFn` by
inlining the TTS-synth → write-temp-file → play flow:

```ts
const result = await tts.synthesize({ text });
const dir = mkdtempSync(pathJoin(tmpdir(), "muse-proactive-speak-"));
const audioFile = pathJoin(dir, `notice.${result.format}`);
writeFileSync(audioFile, result.audio);
const player = platform() === "darwin" ? "afplay" : "aplay";
await playAudioWithWatchdog(player, audioFile);
```

— with **no cleanup**. Every spoken proactive notice left a
`/tmp/muse-proactive-speak-XXXXXX/notice.<fmt>` directory +
file behind. The proactive daemon is long-running and fires
notices throughout the day, so this accumulates faster than
any other speak path — the worst leaker of the three
(`brief`, `listen`, `proactive`).

Goal 630 already built the canonical, properly-cleaned-up
helper for exactly this:
`apps/cli/src/voice-playback.ts:synthesizeAndPlay(tts,
options, shells?)` — it synthesizes, writes to a `mkdtemp`
dir, plays via `shells.playAudio`, and `rmSync`s the dir in
a `finally` (both success and error paths). Its default
`shells.playAudio` resolves to
`playAudioWithWatchdog(platform === "darwin" ? "afplay" :
"aplay", file)` — byte-identical to what the proactive
code did manually.

Goal 662's Remaining Risks flagged this exact site:

> `apps/cli/src/commands-proactive.ts:231` — proactive
> daemon's `--speak` mode. Same defect class. Could
> sibling-apply.

This iter routes the proactive `speakFn` through
`synthesizeAndPlay`, closing the leak and removing the
duplication.

### Defect class

**Route an inline copy through the shared helper that
already has the fix (DRY + temp-dir cleanup)**. Same shape
as goal 663 (route inline embeds to the shared `embed()`)
and a follow-through on goal 662 / 630 (mkdtemp cleanup).
A `fix:` because it closes a real reachable leak, not just
a cosmetic refactor.

Recent 10-iter window:

- 665: execution-layer clamp
- 664: config upper bound
- 663: refactor DRY (route to shared embed)
- 662: mkdtempSync cleanup (brief --speak)
- 661: concurrent RMW race
- 660: Promise.race timer leak
- 659: HTTP redirect SSRF
- 658: sort comparator tiebreaker
- 657: secret patterns ext (PGP)
- 656: secret patterns ext (PEM)

## Slice

- `apps/cli/src/commands-proactive.ts`:
  - Replaced the inline `speakFn` body (dynamic
    `mkdtempSync` / `writeFileSync` / `tmpdir` / `platform`
    imports + manual temp-dir lifecycle + no cleanup) with
    a single `await synthesizeAndPlay(tts, { text })`.
  - Dropped the now-unused dynamic imports of `node:fs`,
    `node:os`, `node:path`, and `playAudioWithWatchdog`.
  - The surrounding try/catch (user-visible "speak failed"
    `io.stderr`) is preserved.

## Verify

- `pnpm --filter @muse/cli test`: 1131 passed (unchanged
  count — pure refactor to an already-tested helper). Full
  `pnpm check`: every workspace green; tsc strict EXIT=0.
- **Proof of preservation rests on the helper's own
  tests**: `apps/cli/src/voice-playback.test.ts` already
  has the two cleanup tests goal 630 added:
  - "removes the mkdtemp dir … on every TTS play"
  - "removes the mkdtemp dir EVEN when playAudio throws —
    finally cleanup must not leak on the error path"
  Routing proactive through `synthesizeAndPlay` means the
  proactive `--speak` path inherits both guarantees. The
  proactive command's own tests (call-site shape) continue
  to pass.
- `pnpm lint`: 0 errors / 0 warnings.
- `pnpm guard:core`: clean.
- Byte-hygiene scan on the touched file: clean.
- No LLM request/response wire path touched. The TTS synth
  is from `@muse/voice`; the speak path is exercised by the
  helper's tests with a fake TTS. `smoke:live` doesn't
  apply.

## Status

Done. All three `--speak` surfaces now clean up their temp
dirs via a properly-tested path:

| Surface                  | Temp-dir cleanup            | Via                                   |
| ------------------------ | --------------------------- | ------------------------------------- |
| `muse brief --speak`     | yes (goal 662)              | `playSynthesizedAudio` (brief-local)  |
| `muse listen` ambient    | partial (file unlink, not dir) | inline (sibling-fixable)           |
| `muse proactive --speak` | **yes (this iter)**         | `synthesizeAndPlay` (voice-playback)  |

Pre-fix the proactive daemon leaked one
`/tmp/muse-proactive-speak-*` dir per spoken notice — the
fastest leaker since it runs continuously. Post-fix: zero
leaks.

## Decisions

- **Routed through `synthesizeAndPlay`, not
  `playSynthesizedAudio`** (the brief-local helper from
  goal 662). `synthesizeAndPlay` lives in
  `voice-playback.ts`, does the full synth+play+cleanup,
  and its default `shells.playAudio` is exactly the
  `playAudioWithWatchdog(afplay/aplay)` the proactive code
  used. Perfect fit; no new helper needed.
- **Dropped the dynamic imports** (`mkdtempSync`,
  `writeFileSync`, `tmpdir`, `platform`,
  `playAudioWithWatchdog`) — they were only used by the
  inline copy. The single `synthesizeAndPlay` dynamic
  import replaces all of them. Keeps the lazy-load posture
  (the whole speak setup is behind `if (options.speak)`).
- **No new test added**. Pure refactor to an
  already-tested helper, same rationale as goal 663. The
  `synthesizeAndPlay` cleanup tests (goal 630) prove the
  behavior; adding a duplicate test at the proactive call
  site would test the helper twice.
- **Did NOT touch `commands-listen.ts`** in this iter. It
  uses a different player abstraction (`shells.playAudio`
  injected at a higher level) and only unlinks the file,
  not the dir — a smaller leak (empty dir per ambient
  clip). Sibling-fixable; could route through
  `synthesizeAndPlay` too in a future iter.
- **No mutation step**. A pure refactor where the
  behavior-preserving proof is the unchanged test suite +
  the helper's existing cleanup tests. The "mutation"
  would be reverting to the inline copy, which the helper's
  cleanup tests already cover for the leak symptom.

## Remaining risks

- **`commands-listen.ts:119`** still has the
  unlink-file-but-not-dir pattern (a smaller leak: one
  empty dir per ambient-wake clip). Sibling-fixable by
  routing through `synthesizeAndPlay`.
- **The `synthesizeAndPlay` default shells** pick
  `afplay`/`aplay` by platform. A headless Linux box
  without `aplay` would have the player fail — but
  `synthesizeAndPlay`'s `finally` still cleans up the dir,
  and the surrounding try/catch in proactive surfaces the
  error. No regression.
- **`muse listen`'s player injection** means a future
  consolidation would need `synthesizeAndPlay` to accept a
  custom `shells` (it already does — third param). So the
  sibling fix is straightforward when it comes.
- **The proactive daemon's speak path is opt-in**
  (`--speak`), so the leak only affected users who enabled
  it. Still, those are exactly the heavy-dogfood users
  most likely to notice `/tmp` filling up.
