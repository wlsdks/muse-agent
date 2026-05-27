# Goal 887 — `muse setup`/`doctor` surfaces an advisory on an otherwise-`ok` section

## Outward change

The human-readable `muse setup` status report now prints a section's
`nextStep` advisory even when that section's status is `ok`. The
immediate beneficiary is goal 886's voice warning: a user who set
`MUSE_VOICE_TTS=piper` but forgot `MUSE_PIPER_VOICE` has a voice
section that resolves (`status: ok`, `tts=openai-tts`) **with** an
advisory `nextStep` — but the text renderer only printed `nextStep`
in the non-`ok` branch, so the warning that 886 added was visible
only in `--json`. Now `muse setup` shows:

```
  [ok]  voice — stt=openai-whisper, tts=openai-tts
         → MUSE_VOICE_TTS=piper needs MUSE_PIPER_VOICE … fell back to openai-tts.
```

## Why this, now

886 introduced the first case of an `ok` section carrying a
`nextStep`; the renderer's per-section `if ok {push} else {push +
pushNext}` shape silently dropped it on the human surface — so the
fix shipped in 886 was inert for anyone not reading JSON. A real
seam created by the prior slice (exactly the "does it compose end to
end?" check). Fixing it makes 886's zero-cost warning actually
reach the user.

## How

- Extracted the whole snapshot→text renderer out of the async,
  env+FS-bound `renderSetupStatus` into a pure exported
  `formatSetupStatusLines(snap): string[]` (the established
  "pure-fn-from-IO-fn" testability pattern). `renderSetupStatus` now
  just collects the snapshot and joins the lines.
- The voice section pushes its row in the `ok`/`else` branches as
  before, then **always** calls `pushNext(snap.voice.nextStep)` —
  `pushNext` already no-ops on `undefined`, so a normal `ok` voice
  (no advisory) is unchanged; only a resolved-but-fell-back config
  now surfaces its guidance.

## Verification

`apps/cli` `commands-scheduler-setup.test.ts`: two
`formatSetupStatusLines` cases over a hand-built snapshot — voice
`status: ok` + a piper-fallback `nextStep` renders both the `ok`
row AND the `→ MUSE_VOICE_TTS=piper …` advisory; an `ok` voice with
no `nextStep` renders the row and no stray advisory. Mutation-proven:
moving `pushNext` back inside the `else` branch fails the warning
case. Pure-renderer extraction otherwise behaviour-preserving (the
existing scheduler-`next` tests stay green). `pnpm check` exit 0
(tsc caught a missing `status` field in the test fixture — fixed),
`pnpm lint` 0/0. Config-diagnostics path, not the LLM path → no
smoke:live (Ollama down regardless).

## Decisions

- Surfacing `nextStep` unconditionally for the voice section (not
  globally for every section) keeps the change scoped to the one
  section that can be `ok`-with-advisory today; other sections only
  carry `nextStep` when non-`ok`, where it already renders.
