# 283 — a non-positive / non-finite jwtExpirationMs silently broke ALL auth

## Why

`JwtTokenProvider` is the auth core: every server request is
gated by `parseToken`. The constructor rigorously validates the
HMAC secret (throws `WEAK_JWT_SECRET` below 32 bytes) but did
**nothing** for the token lifetime:

```ts
this.jwtExpirationMs = properties.jwtExpirationMs ?? defaultJwtExpirationMs;
```

`?? default` only substitutes `null` / `undefined`. A
misconfigured `jwtExpirationMs` of `NaN` (e.g. `Number(env)` on a
blank/garbage value), `0`, a negative, or `Infinity` passes
straight through, and then:

- `createToken`: `exp = Math.floor((now + NaN)/1000)` → `NaN`;
  `JSON.stringify` serialises that to `"exp":null`, so
  `isJwtClaims` (`typeof null !== "number"`) rejects **every**
  freshly-minted token.
- `0` / negative → `exp ≤ now` → every token is **immediately
  expired**.
- `Infinity` → `exp` serialises to `null` → rejected.

Net: a single bad config value silently takes down **all
authentication** — every token the server issues is rejected by
the same server — with **no diagnostic** at startup. Separately,
`isJwtClaims` used `typeof value.exp === "number"`, which is
`true` for `NaN`; combined with `parseToken`'s `claims.exp <=
now` (`NaN <= n` is `false`) that is a latent "never expires"
footgun at the verify boundary.

## Scope

`packages/auth/src/jwt.ts`:

- Constructor: after resolving `jwtExpirationMs`, throw
  `AuthError("INVALID_JWT_EXPIRATION", …)` unless it is a finite
  number `> 0`. Same fail-fast posture as the adjacent
  `WEAK_JWT_SECRET` check — a loud, actionable startup error
  instead of a silent auth outage. One short WHY comment records
  why `?? default` is insufficient.
- `isJwtClaims`: require `Number.isFinite(value.iat)` /
  `Number.isFinite(value.exp)` instead of `typeof === "number"`,
  closing the `NaN`-exp "never expires" footgun at the
  verification boundary (defense-in-depth — the same
  expiry-must-be-finite invariant, enforced at verify as well as
  at mint).

Behaviour preserved for every valid configuration and token:
finite positive expirations construct and round-trip exactly as
before; well-formed claims (finite numeric `iat`/`exp`) still
validate.

## Verify

- `pnpm --filter @muse/auth test` — 33 pass. New hardening test:
  `jwtExpirationMs` of `NaN` / `Infinity` / `0` / `-1000` each
  throws `/jwtExpirationMs must be a positive finite number/`,
  the thrown error is an `AuthError` with code
  `INVALID_JWT_EXPIRATION`, and a valid `60_000` still mints a
  token that `parseToken` accepts (`sub` round-trips). Existing
  alg-confusion / tamper / wrong-secret / weak-secret / rotation
  tests stay green.
- `pnpm check` — every workspace green (auth 33, apps/cli 561,
  apps/api 160, all packages). `pnpm lint` — exit 0.
- No real-LLM request/response path touched (deterministic auth
  config validation + claims hardening). A live Qwen run cannot
  reproduce a misconfigured JWT lifetime, so the deterministic
  tests are the rigorous verification — same stance as the JWT /
  guard hardening goals 268 / 269 and 261 / 274–282.

## Status

done — a bad `jwtExpirationMs` now fails fast at construction
with a clear `AuthError` instead of silently rejecting or
pre-expiring every token the server issues, and the claims
verifier rejects a non-finite `exp`/`iat`. Valid configs and
tokens are unchanged.
