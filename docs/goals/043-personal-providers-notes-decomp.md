# 043 — Extract buildNotesRegistry into registry-builders/notes.ts

## Why

Same continuation. Notes builder ~80 LOC + tryBuildNotesProvider helper.

## Scope

- Same shape.

## Verify

- personal-providers.ts < 400 LOC after.

## Status

done — `buildNotesRegistry` + `tryBuildNotesProvider` moved to
`registry-builders/notes.ts` mirroring 007 / 041 / 042.
`personal-providers.ts`: 429 → 349 LOC (beats the <400 target).
The notes-provider classes are no longer imported in
`personal-providers.ts` (the notes builder owns them). Function
re-exported so callers stay byte-identical. All gates green.
