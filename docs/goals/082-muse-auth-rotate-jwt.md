# 082 — muse auth rotate-jwt — operator-driven JWT secret rotation

## Why

The auth service already supports a `previousJwtSecrets` grace
window so a rotated key doesn't invalidate every in-flight
session. There's no CLI surface to trigger the rotation though —
operators have to hand-edit env vars and restart the daemon.

## Scope

- New `muse auth rotate-jwt [--grace-hours N]` subcommand.
- Writes a fresh 32-byte hex secret to `~/.muse/auth.json`,
  pushes the old value into `previousJwtSecrets` with a
  `validUntil` timestamp = now + grace-hours (default 24).
- Reuses the existing `AuthService.rotateSecret` path if one
  exists; otherwise add it.
- Live server picks up the rotation via the auth-service's
  file-watch hook (already present for credentials reload).

## Verify

- cli +1 test on the rotation round-trip (old token still
  authenticates inside grace; rejected after the window).
- auth +1 test on `rotateSecret`'s `validUntil` arithmetic.

## Status

open
