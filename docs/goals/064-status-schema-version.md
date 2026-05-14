# 064 — muse status JSON gains a schemaVersion field

## Why

Long-running scripts that pipe muse status --json into jq want a
stable schema marker so they can detect breaking changes.

## Scope

- Add 'schemaVersion: 1' to the top-level snapshot.
- Increment when fields are removed/renamed.

## Verify

- cli +1 test.

## Status

open
