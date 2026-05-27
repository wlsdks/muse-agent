# 522 — `JwtTokenProvider.extractExpiration` returns `undefined` (not an Invalid Date) when `exp * 1000` overflows the JS Date range (goal-440/453/459/465/508/509/510 sibling on the auth wire path)

## Why

`packages/auth/src/jwt.ts:145` returned `new Date(claims.exp * 1_000)`
without checking whether the multiplication produced a valid Date:

```ts
extractExpiration(token: string): Date | undefined {
  const claims = this.parseToken(token);
  return claims ? new Date(claims.exp * 1_000) : undefined;
}
```

`claims.exp` is validated as `Number.isFinite(value.exp)` by
`isJwtClaims`, but **finite ≠ within Date range**. The JS `Date`
constructor rejects ms values outside ±8.64e15 (±100M days from
epoch). A finite `exp` value like `1e13` (a token minted with a
giant `jwtExpirationMs` — accepted by the constructor as long as
it's positive + finite) produces `exp * 1_000 = 1e16 > 8.64e15`
and yields an Invalid Date.

The downstream caller at `packages/auth/src/index.ts:163`
expects an undefined-or-clean-Date from `extractExpiration` so
the `??` fallback fires on bad tokens:

```ts
const expiresAt = this.options.jwt.extractExpiration(token)
  ?? new Date(Date.now() + defaultJwtExpirationMs);
```

But `??` doesn't catch Invalid Date — an Invalid Date is a
truthy object. So a corrupt/oversized `exp` claim returns
Invalid Date from `extractExpiration`, the `??` doesn't fire,
and `expiresAt = Invalid Date` flows into the `LoginResult`
returned to API consumers. The first downstream
`expiresAt.toISOString()` (in JSON serialisation, logging,
HTTP response shaping) then throws `RangeError: Invalid time
value` — crashing the login response over a single corrupt
token.

Same finite-Date defect class as goals 440 / 453 / 459 / 465 /
508 / 509 / 510. The convention has landed on the messaging-
ingress (Slack tsToIso, goal 508), CLI render (telemetry, 509),
OpenAI-compat record (510). The auth JWT path was the
remaining outlier on this defect class — and on a security-
adjacent route (`/auth/login`, `/auth/register`, `/auth/refresh`).

## Slice

- `packages/auth/src/jwt.ts` — added the finite-Date guard
  inside `extractExpiration`:
  ```ts
  extractExpiration(token: string): Date | undefined {
    const claims = this.parseToken(token);
    if (!claims) return undefined;
    const date = new Date(claims.exp * 1_000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  ```
  Behaviour byte-identical for every clean `exp` value
  (current-day seconds-since-epoch, ~1.7e9 → `*1000` ~1.7e12,
  well within Date range). Only the `exp * 1000 > 8.64e15` /
  `< -8.64e15` overflow paths now return `undefined` instead
  of an Invalid Date.
- `packages/auth/test/auth.test.ts` — two new tests:
  - mint a token with `jwtExpirationMs = 1e16` (around the
    edge of Date range), assert `extractExpiration` returns
    `undefined` (not an Invalid Date)
  - sanity: a normal `jwtExpirationMs = 60_000` token returns
    a finite Date

## Verify

- New tests 2/2 green; full `@muse/auth` suite green (37
  passed, +2 vs baseline 35, 0 failed); tsc strict EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting the
  guard back to a bare `return new Date(claims.exp * 1_000);`
  makes the overflow test fail with the precise pre-fix
  symptom — `expected Invalid Date to be undefined`. The
  normal-token test stays green. Fix restored, suite back to
  2 green.
- `pnpm check` EXIT=0, every workspace green; `pnpm lint`
  0/0; `pnpm guard:core` clean; byte-scan clean; `git status`
  shows only the two intended files.
- Pure expiration extractor — no LLM request-response wire
  path; `smoke:live` does not apply (per `testing.md` /
  iteration-loop Step 9). The defended path is
  `/auth/{login,register,refresh}` → `LoginResult.expiresAt`,
  not the model loop.

## Status

Done. A JWT with a pathological-but-finite `exp` claim no
longer crashes the login/register/refresh response with
`RangeError: Invalid time value` on `expiresAt.toISOString()`.
The downstream `??` fallback at `packages/auth/src/index.ts`
now fires correctly because `extractExpiration` returns
`undefined` (not a truthy Invalid Date) on the overflow path.

The finite-Date guard convention now covers six sibling sites
consistently:
- messaging-ingress: `slack-provider.ts` `tsToIso` (508)
- CLI render: `commands-telemetry.ts` `formatRecordedAtIso` (509)
- OpenAI-compat: `compat-session-tag-store.ts` `safeIsoFromMs` (510)
- agent-core / mcp pre-existing (`personal-activity-feed`,
  `personal-status-summary`)
- auth JWT: `jwt.ts` `extractExpiration` (this goal)

Each fallback is tailored to its consumer contract — here,
`undefined` so the existing `??` fallback at the call site
takes over.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; a sibling-asymmetry safety
`fix:` on the JWT expiration extractor, recorded honestly
with this backlog row — not a false metric.

## Decisions

- Step-8 redirect from the trim-fallback run on `muse feeds
  add` (520 / 521) to a different defect class entirely
  (finite-Date guard) on a different package (`@muse/auth`).
  Productive variation; the recent strict-parse / trim runs
  haven't touched this defect class.
- Returned `undefined` (not a fallback Date) on overflow:
  this lets the caller's `??` short-circuit pick whatever
  fallback the call site has already declared
  (`new Date(Date.now() + defaultJwtExpirationMs)`). Mirrors
  the goal-509 `formatRecordedAtIso` decision to make the
  fallback caller's concern, not the helper's — different
  callers may want different fallbacks (login result vs.
  bearer-auth response vs. a future audit consumer).
- Did NOT cap `jwtExpirationMs` at the constructor: the
  constructor's `Number.isFinite && > 0` check is correct
  for what it tests (positive finite). Capping
  `jwtExpirationMs` to a "sane" upper bound would be a
  behaviour change for legitimate long-lived service-account
  tokens. The right defence is at the **read** boundary
  (where the Date object is materialised), not at the mint
  boundary.
- The `1e16` value in the test produces `exp ≈ 1e13`, and
  `1e13 * 1000 = 1e16 > 8.64e15` — the smallest overflow
  case that still uses a finite `Number.isFinite`-passing
  `jwtExpirationMs`. Pinning the exact boundary value would
  be brittle (the Date max is JS-engine-specific); the
  off-by-one isn't material.
