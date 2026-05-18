# 374 — migration redaction leaked Linux /home and /root paths

## Why

`redactMigrationText` (`packages/policy/src/migration-redaction.ts`)
is a security primitive: it strips private material (connection
URIs with inline passwords, emails, tokens, URLs, filesystem paths)
out of migration / diagnostic text before it can be surfaced or
shared. The non-negotiable "don't leak credentials / private
material" posture depends on its pattern set being complete.

The `path` rule only matched macOS home paths:

```ts
{ kind: "path", pattern: /\/Users\/[^\s)"'<>]+/g, ... }
```

Muse explicitly supports Linux (the goal-093 `LinuxLibnotifyProvider`
parallels the macOS one). On Linux the home directory is
`/home/<username>/…` and the privileged account is `/root/…` —
neither was redacted. Empirically confirmed on the built module:
`/home/jdoe/secret/app.log` and `/root/.ssh/id_rsa` passed through
**verbatim** while `/Users/jane/…` was redacted. That leaks the OS
username (PII) and private project / key paths from any Linux
user's diagnostic text. There is no documented macOS-only scope —
this is an omission (written on a Mac), not a deliberate design,
unlike the codebase's *documented* deliberate-rejection stances.

## Scope

`packages/policy/src/migration-redaction.ts`: the `path` pattern
generalised from `\/Users\/` to `\/(?:Users|home|root)\/`. One
alternation, same `kind: "path"`, same replacement and
finding-counting. Conservative and safe-by-direction: in migration
text these prefixes are unambiguously filesystem home/root paths,
and over-redaction is the correct bias for a PII/secret stripper.
`/var`, `/etc`, `/usr`, `/tmp` and other non-home system paths are
deliberately still left intact (no username/secret component) so
the log stays diagnosable — and a bare `/home/ ` with no user
segment stays intact (`[^\s…]+` requires ≥1 path char).

New `it` in `packages/policy/test/redaction.test.ts`: asserts
`/home/jdoe`, `/root/.ssh`, and `/Users/bob` (no regression) are all
gone, `/var/log/app.log` is preserved, and the `path` finding count
is 3. Every expected value was empirically verified against the
rebuilt module before asserting.

## Verify

- `pnpm --filter @muse/policy test` — 68 pass, 11 suites (+1; the
  existing `/Users/` redaction test stays green — no regression).
- `pnpm check` — every workspace green (apps/cli, apps/api 165, all
  packages).
- `pnpm lint` — exit 0.
- goal-227/328 byte scan clean on both touched files.
- No real-LLM request/response path touched — pure regex redaction.
  The deterministic suite with pre-write empirical verification is
  the rigorous verification.

## Status

done — `redactMigrationText` now strips Linux `/home/<user>/…` and
`/root/…` paths in addition to macOS `/Users/…`, closing a
cleartext PII/secret-path leak for Linux users while leaving
non-home system paths intact for diagnosability.
