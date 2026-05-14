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

done — `muse export [--output <path>]` bundles every present
`~/.muse/*.json` plus the notes tree into a timestamped
`.tar.gz` via system `tar` (universally available on macOS /
Linux). Missing / empty files are silently skipped. The archive
is laid out so a single `tar -xzf <bundle>.tar.gz -C $HOME`
re-creates `~/.muse/` exactly as it was — a `README.md` inside
the tarball lists every captured file plus the restore command.

cli +1 test asserts the per-file collection (present /
empty-skip / missing-skip), tarball is non-empty, README cleanup
ran, and the README structural shape (header + items + restore
command) is correct.
