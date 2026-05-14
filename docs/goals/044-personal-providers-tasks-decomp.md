# 044 — Extract buildTasksRegistry into registry-builders/tasks.ts

## Why

Same continuation. Tasks builder ~86 LOC + tryBuildTasksProvider helper.

## Scope

- Same shape.

## Verify

- personal-providers.ts < 330 LOC after; now mostly path resolvers + re-exports.

## Status

open
