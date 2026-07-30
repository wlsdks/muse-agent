# @muse/auth

Password hashing, JWT issuance/verification, and user stores for the API's bearer-token auth.
Ships both a sync (`Auth`) and async (`AsyncAuth`) variant over the same `MuseAuth` interface so
callers can choose an in-memory or Kysely-backed user store.

## Public surface

- `.` (`src/index.ts`) — `MuseAuth` and its implementations (`Auth`, `AsyncAuth`), `AuthProvider`/
  `AsyncAuthProvider` and their default implementations (`DefaultAuthProvider`,
  `KyselyAuthProvider`), `PasswordHasher` (scrypt-based), `JwtTokenProvider`,
  `parseJwtRotationState`, user stores (`InMemoryUserStore`, `KyselyUserStore`, `normalizeEmail`),
  `AuthError`, `extractBearerToken`, and `currentActor`.

## Depends on

- `@muse/db` — `KyselyUserStore` reads and writes through the shared schema's `users` table.
- `@muse/shared` — base primitives.

## Rules that bind this package

- Credential-handling: passwords are hashed with scrypt and compared with `timingSafeEqual`
  (never a plain `===`); a hash of the wrong decoded length is rejected outright rather than
  falling through to an empty-buffer comparison bypass — see the guard comment in
  `PasswordHasher.verify`.
- `KyselyUserStore` has an in-memory counterpart (`InMemoryUserStore`) so a caller without
  PostgreSQL still runs, per `../../.claude/rules/architecture.md`'s database rules.
- No plaintext credential persistence, per `../../.claude/rules/commits.md` (never commit live
  credentials) and the architecture rules' credential-handling posture.

## Tests

`pnpm --filter @muse/auth test`
