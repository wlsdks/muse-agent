# 007 — personal-providers.ts decomp (710 LOC)

## Why

Third-largest source file. Holds 5 independent registry builders
(calendar, notes, tasks, voice, messaging) + `mergeModelKeysFromFile`
+ small helpers. Each builder is ~80-100 LOC of similar shape:
read env → fan out to provider impls → return a registry. Natural
candidate for per-registry split.

## Scope

- New files under `packages/autoconfigure/src/registry-builders/`:
  `calendar.ts`, `notes.ts`, `tasks.ts`, `voice.ts`, `messaging.ts`.
- `personal-providers.ts` re-exports each `buildXxxRegistry` so
  callers in `index.ts` stay byte-identical.
- `mergeModelKeysFromFile` + `ensureNotesDir` stay in
  `personal-providers.ts` (they don't fit a single registry).

## Verify

- pnpm check / lint / smoke broad + live.
- personal-providers.ts < 350 LOC after split.
- No test changes (everything is already covered transitively).

## Status

open
