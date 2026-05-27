# 523 — `Auth.authenticateBearer` / `AsyncAuth.authenticateBearer` reject a token whose `exp` claim overflows the Date range (goal-522 sibling on the bearer-auth path)

## Why

Goal 522 closed the finite-Date guard on
`JwtTokenProvider.extractExpiration`. Two analogous sites in the
same package were still computing `new Date(claims.exp * 1_000)`
**inline** in `Auth.authenticateBearer` and
`AsyncAuth.authenticateBearer` and returning the result inside an
`AuthIdentity`:

```ts
// packages/auth/src/index.ts:233 (sync Auth)
return {
  accountId: claims.accountId,
  email: claims.email,
  expiresAt: new Date(claims.exp * 1_000),
  tokenId: claims.jti,
  userId: claims.sub
};

// packages/auth/src/index.ts:330 (async AsyncAuth)
return {
  accountId: claims.accountId,
  email: claims.email,
  expiresAt: new Date(claims.exp * 1_000),
  tokenId: claims.jti,
  userId: claims.sub
};
```

The same defect as 522 here: a finite-but-oversized `exp` claim
(possible because `JwtTokenProvider.parseToken` validates
`Number.isFinite(claims.exp)` but not the Date-range overflow of
`exp * 1_000`) produces an Invalid Date that flows into the
caller as `AuthIdentity.expiresAt: Date`. The `AuthIdentity`
interface types `expiresAt` as `Date` (not `Date | undefined`),
so consumers don't expect to need to validate it — they call
`expiresAt.toISOString()` for JSON serialisation, audit logging,
or HTTP response shaping, and `RangeError: Invalid time value`
crashes the bearer-auth flow.

The bearer-auth path is the **request-time** wire path
(`requireAuthenticated` middleware on every protected route),
not just the login-time path that goal 522 closed. Closing the
sibling-asymmetry across all three sites in the package gives
the auth surface one consistent reject-on-overflow posture.

## Slice

- `packages/auth/src/index.ts` — at both
  `Auth.authenticateBearer` (sync, line 219) and
  `AsyncAuth.authenticateBearer` (async, line 316), interpose the
  finite-Date guard between `parseToken` and the
  `AuthIdentity` construction:
  ```ts
  const expiresAt = new Date(claims.exp * 1_000);
  if (!Number.isFinite(expiresAt.getTime())) {
    return undefined;
  }
  return { …, expiresAt, … };
  ```
  Behaviour byte-identical for every clean `exp` value; only the
  overflow paths now return `undefined` (treated as "auth
  rejected" by `requireAuthenticated`) instead of leaking an
  Invalid Date through the `AuthIdentity`.
- `packages/auth/test/auth.test.ts` — added one new test
  exercising the sync `Auth.authenticateBearer` with a token
  minted via `jwtExpirationMs = 1e16`: asserts the identity is
  `undefined` (not a struct with an Invalid `expiresAt`).

## Verify

- New test 1/1 green; full `@muse/auth` suite green (38 passed,
  +1 vs baseline 37, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the sync
  `Auth.authenticateBearer` guard back to a bare `new Date(claims.
  exp * 1_000)` makes the test fail with the precise pre-fix
  symptom — `expected { accountId: undefined, …(4) } to be
  undefined` (the function returned the full AuthIdentity
  with an Invalid Date `expiresAt` instead of rejecting). Fix
  restored, suite back to all green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure bearer-auth guard — no LLM request-response wire path;
  `smoke:live` does not apply (per `testing.md` / iteration-
  loop Step 9). The defended path is the
  `requireAuthenticated` middleware → `AuthIdentity.expiresAt`
  flow, not the model loop.

## Status

Done. A bearer token with a pathological-but-finite `exp`
claim no longer leaks an Invalid Date through the
`AuthIdentity.expiresAt` field where downstream JSON
serialisation, audit logging, or HTTP response shaping would
crash on `.toISOString()`. The finite-Date guard convention
now reads identically across all three sites in `@muse/auth`:

- `JwtTokenProvider.extractExpiration` (goal 522)
- `Auth.authenticateBearer` (this goal)
- `AsyncAuth.authenticateBearer` (this goal)

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry safety
`fix:` on the bearer-auth path, recorded honestly with this
backlog row — not a false metric.

## Decisions

- Inlined the guard at both sites rather than extracting a
  helper: the check is two lines, and a helper would have to
  return `Date | undefined`, complicating the call site as
  much as the inline version. Mirrors the goal-509
  `formatRecordedAtIso` decision — when the call site is
  small and explicit, inline beats a tiny helper.
- Returned `undefined` (which `requireAuthenticated` treats
  as "unauthenticated") rather than a fabricated Date: a
  token whose `exp` claim is pathological is not a token we
  want to honour. Same posture as the goal-522 decision for
  `extractExpiration`.
- Tested only the sync `Auth.authenticateBearer` path
  directly — the async path is byte-for-byte the same shape
  and the same fix is applied identically. Cross-package
  convention is to test one representative of a pair when
  the implementations are mechanical copies; if the two
  paths diverge in the future the divergence itself is the
  bug.
- Step-8 continuation from goal 522 onto the analogous
  bearer-auth sites in the same package — same defect class
  on closely-related code paths is the established "close the
  asymmetry" pattern (see goals 520 / 521 on `muse feeds
  add`'s flag-then-positional sweep).
