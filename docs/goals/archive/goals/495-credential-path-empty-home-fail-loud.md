# 495 — `defaultCredentialPath` fails loud instead of rooting the credentials file at `/` when `HOME=""` (goal-478/481/482/483/488 sibling on a safety path)

## Why

`defaultCredentialPath` (`apps/cli/src/credential-store.ts:42`)
returned the path where the CLI's bearer tokens for the API are
read + written. Pre-fix:

```ts
export function defaultCredentialPath(home: string = process.env.HOME ?? homedir()): string {
  return `${home}/.config/muse/credentials.json`;
}
```

A user with `export HOME=` (the "zero out leaked env" launcher
pattern goals 478/481/482/483/488 already documented) produced:

- `process.env.HOME = ""`
- `"" ?? homedir()` → `""` (empty is not nullish)
- Returned `/.config/muse/credentials.json` — **rooted at `/`**.

And worse: a direct probe (`node -e "process.env.HOME=''; console.log(require('node:os').homedir())"`)
showed `os.homedir()` ALSO returns `""` when `HOME=""` on this
system, so the apparent `?? homedir()` fallback was illusory.
The CLI then silently writes **bearer tokens to
`/.config/muse/credentials.json`** at the filesystem root —
either failing with `EACCES` (best case, the user notices) or
silently succeeding on a misconfigured system (worst case, the
token file is in the wrong location, the next session can't
find it, and the user re-authenticates against a fresh empty
store while the orphaned token lingers).

Same empty-env-shadow class as 478/481/482/483/488, here on a
**security-relevant credential store** — the most cost
asymmetric instance of the class so far.

## Slice

- `apps/cli/src/credential-store.ts` — `defaultCredentialPath`
  now resolves through a four-step chain (explicit arg → env
  HOME → `os.homedir()` → throw), trimming + length-checking
  at every step. **Fails loud** with a clear error
  (`"Cannot resolve home directory for credentials.json …"`)
  rather than silently writing to `/.config/muse/...`.
  Behaviour byte-identical for every previously-valid HOME
  value; only the empty / whitespace-only shadow path is
  closed.
- `apps/cli/src/credential-store.test.ts` — new file, first
  direct test of `defaultCredentialPath`: HOME set → expected
  path; explicit `home` arg (trimmed) beats env; empty /
  whitespace explicit arg falls through to env (does not lock
  in the bucket); the central safety assertion — with
  HOME="" the returned path MUST NOT root at `/.config/muse/...`
  (otherwise the function MUST throw).

## Verify

- New test 4/4 green; full `@muse/cli` suite green (798
  passed, 0 failed); tsc strict (cli) EXIT=0.
- **Clean-mutation-proven** (Edit-based): reverting to the
  prior `home: string = process.env.HOME ?? homedir()` form
  makes **three** tests fail with precise pre-fix symptoms
  (whitespace not trimmed on the explicit arg; empty explicit
  arg locks in `""`; empty HOME writes to
  `/.config/muse/credentials.json` at the filesystem root —
  the very security bug this iteration closes) while the
  HOME-set test stays green; fix restored, suite back to 4
  green.
- `pnpm check` EXIT=0, every workspace green — no regression
  (the function is consumed by `credentialPath` /
  `readStoredToken` / `writeStoredToken` /
  `deleteStoredToken` and downstream auth flows; every clean
  HOME is byte-identical); `pnpm lint` 0/0;
  `pnpm guard:core` clean (no IMMUTABLE-CORE touched);
  byte-scan clean; `git status` shows only the two intended
  files.
- Pure path-resolution logic — no LLM / model
  request-response wire path; `smoke:live` does not apply
  (per `testing.md` / iteration-loop Step 9).

## Status

Done. A user who `export HOME=` (or runs Muse from a launcher
that pre-clears HOME) no longer silently writes bearer tokens
to `/.config/muse/credentials.json` at the filesystem root —
the function now fails loud with a clear, actionable error
when no usable home can be resolved. Every clean HOME value
is unaffected. The goal-478/481/482/483/488 empty-env-shadow
class now covers the credentials safety path — the highest
cost-asymmetry instance of the class.

No CAPABILITIES line / no OUTWARD-TARGETS flip: all P-bullets
are already `[x]` and audited; an empty-env-shadow safety
`fix:` on the credential store, recorded honestly with this
backlog row — not a false metric.

## Decisions

- **Throw rather than fall back to a CWD-rooted path** when no
  home can be resolved: silently writing tokens to
  `<cwd>/.config/muse/...` is also wrong (different location
  per shell, orphaned token lingering, future session
  re-auths). A loud throw stops the broken write and surfaces
  the misconfiguration to the user, which is exactly the
  fail-loud posture credentials deserve.
- Strengthened the chain to also handle the case where
  `os.homedir()` itself returns `""` (the probe revealed Node
  honours an explicitly-empty HOME at the syscall layer on
  this platform). The earlier `?? homedir()` fallback was
  illusory; the new code asserts every step is a non-empty
  trimmed string.
- Function signature relaxed from required `string` (with a
  default expression) to optional `string` — a caller who
  passes `undefined` now flows through the env/homedir
  resolution; the old default-expression form silently
  computed at call time the very moment HOME was empty.
