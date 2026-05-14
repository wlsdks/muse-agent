# 044 — Extract buildTasksRegistry into registry-builders/tasks.ts

## Why

Same continuation. Tasks builder ~86 LOC + tryBuildTasksProvider helper.

## Scope

- Same shape.

## Verify

- personal-providers.ts < 330 LOC after; now mostly path resolvers + re-exports.

## Status

done — `buildTasksRegistry` + `tryBuildTasksProvider` moved to
`registry-builders/tasks.ts` mirroring 007 / 041 / 042 / 043.
`personal-providers.ts`: 349 → 256 LOC (beats the <330 target,
and the file is now mostly env-driven path resolvers +
re-exports as the goal predicted). Function re-exported so
callers stay byte-identical. All gates green.
