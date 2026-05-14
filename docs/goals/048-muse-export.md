# 048 — muse export — backup all stores to a tarball

## Why

Single-command backup of every ~/.muse/*.json + notes dir. Useful for
laptop migration.

## Scope

- New command commands-export.ts.
- Tar.gz with timestamped name.
- --output <path> override.
- README.md inside lists what's included + restore command.

## Verify

- cli +1 test (verify tar contents).

## Status

open
