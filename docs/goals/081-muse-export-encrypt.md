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

done — `muse export --encrypt` wraps the bundle with AES-256-GCM
using a passphrase-derived key (PBKDF2-SHA256, 200k iterations,
32-byte key, 16-byte salt + 12-byte IV). Layout:

  magic "MUSE" (4) + version (1) + reserved (1) + salt (16) +
  iv (12) + ciphertext (var) + auth-tag (16)

`muse import` auto-detects the magic header so an encrypted
bundle restores via the same `muse import <path>` invocation
the cleartext path uses; `--decrypt` opt-in is available for the
case where an operator wants the assertion enforced. Passphrase
comes from `MUSE_EXPORT_PASSPHRASE` env when set; falls back to
`@clack/prompts` interactive password input otherwise. Output
file gets a `.enc` suffix when encrypting.

cli +2 tests: pure-buffer crypto round-trip (right passphrase,
wrong passphrase, missing magic) + end-to-end build → decrypt →
list-entries through a temp directory.
