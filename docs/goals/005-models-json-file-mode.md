# 005 — Models.json file-mode 0600

## Why

`muse setup model` persists provider tokens to `~/.muse/models.json`.
On Unix the file inherits the default umask (typically `644` —
world-readable). A single-user box is mostly fine, but a shared
machine or a misconfigured rsync could leak the file. Other secret-
bearing stores (notifications.log via LogMessagingProvider) already
use `mode: 0o600` (see `packages/messaging/src/log-provider.ts:81`).
Match that.

## Scope

- Find every writer to `~/.muse/models.json` + any other
  credentials-bearing JSON (calendar oauth, messaging tokens).
- Pass `{ mode: 0o600 }` to the `writeFile` (or `chmod` post-write
  if the writer uses atomic rename).
- Test: writing the file via the wizard yields a file whose
  `stat().mode & 0o777 === 0o600`.

## Verify

- pnpm check / lint / smoke.
- New unit test inspects file mode after a write.

## Status

done — audit verified all three credential-bearing JSON stores
(setup-model.ts → models.json, FileMessagingCredentialStore →
messaging.json, FileCalendarCredentialStore → credentials.json)
already use `mode: 0o600` + post-write `chmod` fallback. No code
change needed. Added a lock-in test against
FileMessagingCredentialStore so future refactors can't silently
regress the mode bits. Skipped on win32 where POSIX mode bits are
meaningless.
