# 081 — muse export --encrypt — passphrase-protected backup tarball

## Why

Goal 048's `muse export` writes a plain `.tar.gz` of `~/.muse/`,
which carries persona facts, credentials, and reminder history.
A laptop migration USB or cloud sync target shouldn't see those
in cleartext. Add an `--encrypt` mode that wraps the bundle with
a passphrase-derived AES-256-GCM stream so the backup is safe to
hand off.

## Scope

- `muse export --encrypt` (prompts for passphrase via clack, or
  reads `MUSE_EXPORT_PASSPHRASE` for headless flows).
- AES-256-GCM via `node:crypto`. Salt + IV in a small header
  prefix; PBKDF2-SHA256 with ≥200k iterations for KDF.
- Mirror flag on `muse import --decrypt` so the restore path
  round-trips. `muse import` auto-detects via header magic.
- Output filename gains `.enc` suffix when encrypted.

## Verify

- cli +2 tests: round-trip clear vs encrypted; wrong passphrase
  fails with a clear error instead of writing garbage.

## Status

open
