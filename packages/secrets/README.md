# @muse/secrets

The `SecretSource` abstraction: resolve a named secret from local sources only (env, OS
keychain, an encrypted store), in order, with a least-privilege scope wrapper. A caller never
receives a source that isn't `local: true`, and a value is never cached or persisted by this
package.

## Public surface

- `.` (`src/index.ts`) — `SecretRef`/`SecretSource` types, `resolveSecret` (try each local source
  in order, first hit wins), `createSecretScope`/`SecretScope` (fail-closed name/service
  allowlist wrapper), `createEnvSource`/`envVarNameFor`, `createKeychainSource` (macOS
  `security` CLI-backed), `createStoreSource`, and re-exported redaction helpers
  (`redactSecrets`, `registerSecretValue`, `hasRegisteredSecrets`) so a caller can import the
  whole surface from one place.

## Depends on

- `@muse/shared` — `registerSecretValue` feeds a resolved value into the process-wide redaction
  registry.

## Rules that bind this package

- Credential-handling: a resolved secret is never persisted in plaintext and this package never
  queries a non-local source, per `../../.claude/rules/architecture.md` and
  `../../.claude/rules/commits.md` (never commit live credentials). See `resolve.ts`'s
  header comment for the exact fail-closed-against-egress invariant.
- `SecretScope` denies-by-default: a `get` for a name/service pair outside the caller's declared
  scope returns `undefined`, never the value, and never even queries a source.

## Tests

`pnpm --filter @muse/secrets test`
