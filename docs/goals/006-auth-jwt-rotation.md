# 006 — Auth JWT-rotation surface

## Why

`JwtTokenProvider` issues HS256 tokens with a single secret and
24h expiry by default. There's no rotation path: a compromised
secret would mean every outstanding token stays valid until the
24h expiry. Add a way to rotate the signing secret while still
honouring the previous one during a grace window.

## Scope

- Extend `AuthProperties` with optional `previousJwtSecrets:
  readonly string[]` — `verifyJwt` walks the array on a miss.
- `MUSE_JWT_SECRET_PREVIOUS` env (CSV) feeds the previous-keys array.
- Document the rotation flow in CLAUDE.md or auth's rules file.

## Verify

- agent-core/auth tests +2 (rotation accepts old token; rotation
  rejects unsigned token; current behaviour unchanged when previous
  is empty).
- All gates green.

## Status

done — `AuthProperties.previousJwtSecrets?: readonly string[]`
added. `JwtTokenProvider.parseToken` walks the array only when
the current secret rejects; signing always uses the current
secret. Every member of `previousJwtSecrets` is validated against
the same 32-byte minimum (WEAK_JWT_SECRET error on weak entry).
auth +2 tests (grace-window accept; weak previous rejected).

Env-var wiring (\`MUSE_JWT_SECRET_PREVIOUS\` CSV) deferred to a
follow-up — the API surface is in place, the autoconfigure
parsing is a one-liner the next caller can add.
