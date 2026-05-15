# 122 — `extractBearerToken` tolerates leading whitespace

## Why

`extractBearerToken(" Bearer abc")` returned `undefined`.
`split(/\s+/u)` on a string with leading whitespace puts an empty
string at index 0, so the destructure landed `scheme = ""` /
`token = "Bearer"`, and `"".toLowerCase() === "bearer"` fails.
Real-world reverse proxies (nginx with certain `proxy_set_header`
rewrites, AWS ALB after auth rules) occasionally prepend
whitespace to the `Authorization` value, and any node-fetch user
who manually built the header (`{ authorization: " Bearer ..." }`)
hit the same trap. Result: a legitimately-issued token bounced as
unauthenticated.

## Scope

- `packages/auth/src/index.ts` `extractBearerToken`:
  - `authorization.trim()` before the split — gets rid of leading
    + trailing whitespace.
  - Short-circuit to `undefined` when the trimmed string is empty
    (was already covered by `if (!authorization)` for `""`, but
    now also covers `"   "`).
  - Splitting / scheme check unchanged.

## Verify

- New `packages/auth/test/auth-hardening.test.ts` case pins:
  - ` Bearer abc` / `   Bearer abc` → `abc`.
  - `Bearer abc ` / `Bearer abc   ` → `abc` (trailing whitespace).
  - `Bearer\tabc` → `abc` (tab separator).
  - `   ` (pure whitespace) → `undefined`.
- `pnpm --filter @muse/auth test` — 30 tests pass.
- `pnpm check` exit 0; `pnpm lint` exit 0.
- `pnpm smoke:live` — 13/0 (auth on the request path; live
  round-trip unaffected).

## Status

done — the bearer-token parser no longer silently rejects
legitimate headers that arrive with a leading space.
