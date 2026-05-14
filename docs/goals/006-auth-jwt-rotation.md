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

open
