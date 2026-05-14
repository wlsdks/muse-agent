# 019 — `muse remember --json`

## Why

`muse remember "<text>"` extracts facts/prefs/vetoes/goals via LLM
and prints them as human-readable lines. Scripting / pipeline use
wants structured output. Add `--json` to emit the parsed payload
+ what was written (vs what was skipped because of duplicates).

## Scope

- `--json` flag in `commands-remember.ts`.
- Emit `{ written: [{ kind, key, value }], skipped: [{ ... reason }] }`.
- Suppress the human-readable lines when `--json`.

## Verify

- pnpm check / lint / smoke broad (no live needed — extraction
  uses a stub in tests).
- cli +1 test.

## Status

open
