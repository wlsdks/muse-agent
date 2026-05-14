# 049 — muse import <tar> — restore from export

## Why

Mirror of 048. Refuse to overwrite existing files unless --force.

## Scope

- New commands-import.ts.
- Extract to ~/.muse/ with collision detection.
- --dry-run mode prints what would change.

## Verify

- cli +2 tests (clean import; collision rejected without --force).

## Status

open
