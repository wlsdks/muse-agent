# 042 — Extract buildVoiceRegistry into registry-builders/voice.ts

## Why

Continuing 007/041. Voice builder ~58 LOC + detectWhisperBinarySync
helper (16 LOC).

## Scope

- Same shape as 041.

## Verify

- personal-providers.ts < 470 LOC after.

## Status

open
