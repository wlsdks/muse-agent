# 042 — Extract buildVoiceRegistry into registry-builders/voice.ts

## Why

Continuing 007/041. Voice builder ~58 LOC + detectWhisperBinarySync
helper (16 LOC).

## Scope

- Same shape as 041.

## Verify

- personal-providers.ts < 470 LOC after.

## Status

done — `buildVoiceRegistry` + `detectWhisperBinarySync` helper
moved to `registry-builders/voice.ts` mirroring 007 (messaging) +
041 (calendar). `personal-providers.ts` shrank from 543 → 429 LOC
(well under the <470 target) and no longer imports any
`@muse/voice` provider classes. Function is re-exported so callers
stay byte-identical. All gates green.
